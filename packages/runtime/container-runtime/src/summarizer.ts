/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { EventEmitter } from "events";
import {
    IDisposable,
    IEvent,
    IEventProvider,
    ITelemetryLogger,
    ITelemetryProperties,
} from "@fluidframework/common-definitions";
import {
    Deferred,
    PromiseTimer,
    Timer,
    IPromiseTimerResult,
} from "@fluidframework/common-utils";
import { ChildLogger, LoggingError, PerformanceEvent } from "@fluidframework/telemetry-utils";
import {
    IFluidRouter,
    IFluidRunnable,
    IRequest,
    IResponse,
    IFluidHandleContext,
    IFluidHandle,
    IFluidLoadable,
} from "@fluidframework/core-interfaces";
import { ContainerWarning, IDeltaManager } from "@fluidframework/container-definitions";
import { wrapError } from "@fluidframework/container-utils";
import {
    IDocumentMessage,
    ISequencedDocumentMessage,
    ISequencedDocumentSystemMessage,
    ISummaryConfiguration,
    MessageType,
} from "@fluidframework/protocol-definitions";
import { create404Response } from "@fluidframework/runtime-utils";
import { GenerateSummaryData } from "./containerRuntime";
import { IConnectableRuntime, RunWhileConnectedCoordinator } from "./runWhileConnectedCoordinator";
import { IClientSummaryWatcher, SummaryCollection } from "./summaryCollection";
import { SummarizerHandle } from "./summarizerHandle";

// Send some telemetry if generate summary takes too long
const maxSummarizeTimeoutTime = 20000; // 20 sec
const maxSummarizeTimeoutCount = 5; // Double and resend 5 times
const maxSummarizeAckWaitTime = 120000; // 2 minutes

const minOpsForLastSummary = 50;

declare module "@fluidframework/core-interfaces" {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    export interface IFluidObject extends Readonly<Partial<IProvideSummarizer>> { }
}

export const ISummarizer: keyof IProvideSummarizer = "ISummarizer";

export interface IProvideSummarizer {
    readonly ISummarizer: ISummarizer;
}

export interface IGenerateSummaryOptions {
    /** True to generate the full tree with no handle reuse optimizations; defaults to false */
    fullTree?: boolean,
    /** True to ask the server what the latest summary is first */
    refreshLatestAck: boolean,
    /** Logger to use for correlated summary events */
    summaryLogger: ITelemetryLogger,
}

export interface ISummarizerInternalsProvider {
    /** Encapsulates the work to walk the internals of the running container to generate a summary */
    generateSummary(options: IGenerateSummaryOptions): Promise<GenerateSummaryData>;

    /** Callback whenever a new SummaryAck is received, to update internal tracking state */
    refreshLatestSummaryAck(
        proposalHandle: string,
        ackHandle: string,
        summaryLogger: ITelemetryLogger,
    ): Promise<void>;
}

const summarizingError = "summarizingError";

export interface ISummarizingWarning extends ContainerWarning {
    readonly errorType: "summarizingError";
    readonly logged: boolean;
}

export class SummarizingWarning extends LoggingError implements ISummarizingWarning {
    readonly errorType = summarizingError;
    readonly canRetry = true;

    constructor(errorMessage: string, readonly logged: boolean = false) {
        super(errorMessage);
    }

    static wrap(error: any, logged: boolean = false) {
        const newErrorFn = (errMsg: string) => new SummarizingWarning(errMsg, logged);
        return wrapError<SummarizingWarning>(error, newErrorFn);
    }
}

export const createSummarizingWarning =
    (details: string, logged: boolean) => new SummarizingWarning(details, logged);

export interface ISummarizerEvents extends IEvent {
    /**
     * An event indicating that the Summarizer is having problems summarizing
     */
    (event: "summarizingError", listener: (error: ISummarizingWarning) => void);
}
export type SummarizerStopReason =
    /** Summarizer client failed to summarize in all 3 consecutive attempts. */
    | "failToSummarize"
    /**
     * Summarizer client detected that its parent is no longer elected the summarizer.
     * Normally, the parent client would realize it is disconnected first and call stop
     * giving a "parentNotConnected" stop reason. If the summarizer client attempts to
     * generate a summary and realizes at that moment that the parent is not elected,
     * only then will it stop itself with this message.
     */
    | "parentNoLongerSummarizer"
    /** Parent client reported that it is no longer connected. */
    | "parentNotConnected"
    /**
     * Parent client reported that it is no longer elected the summarizer.
     * This is the normal flow; a disconnect will always trigger the parent
     * client to no longer be elected as responsible for summaries. Then it
     * tries to stop its spawned summarizer client.
     */
    | "parentShouldNotSummarize"
    /** Parent client reported that it is disposed. */
    | "disposed";
export interface ISummarizer
    extends IEventProvider<ISummarizerEvents>, IFluidRouter, IFluidRunnable, IFluidLoadable {
    /**
     * Returns a promise that will be resolved with the next Summarizer after context reload
     */
    setSummarizer(): Promise<Summarizer>;
    stop(reason?: SummarizerStopReason): void;
    run(onBehalfOf: string): Promise<void>;
    updateOnBehalfOf(onBehalfOf: string): void;
}

type SummarizeReason =
    /**
     * Attempt to summarize after idle timeout has elapsed.
     * Idle timer restarts whenever an op is received. So this
     * triggers only after some amount of time has passed with
     * no ops being received.
     */
    | "idle"
    /**
     * Attempt to summarize after a maximum time since last
     * successful summary has passed. This measures time since
     * last summary ack op was processed.
     */
    | "maxTime"
    /**
     * Attempt to summarize after a maximum number of ops have
     * passed since the last successful summary. This compares
     * op sequence numbers with the reference sequence number
     * of the summarize op corresponding to the last summary
     * ack op.
     */
    | "maxOps"
    /**
     * Special case to generate a summary in response to a Save op.
     * @deprecated - do not use save ops
     */
    | `save;${string}: ${string}`
    /**
     * Special case to attempt to summarize one last time before the
     * summarizer client closes itself. This is to prevent cases where
     * the summarizer client never gets a chance to summarize, because
     * there are too many outstanding ops and/or parent client cannot
     * stay connected long enough for summarizer client to catch up.
     */
    | "lastSummary"
    /** Previous summary attempt failed, and we are retrying. */
    | `retry${1 | 2}`;

const summarizeErrors = {
    /**
     * Error encountered while generating the summary tree, uploading
     * it to storage, or submitting the op. It could be a result of
     * the client becoming disconnected while generating or an actual error.
     */
    generateSummaryFailure: "Error while generating or submitting summary",
    /**
     * The summaryAckWaitTimeout time has elapsed before receiving the summarize op
     * sent by this summarize attempt. It is expected to be broadcast quickly.
     */
    summaryOpWaitTimeout: "Timeout while waiting for summarize op broadcast",
    /**
     * The summaryAckWaitTimeout time has elapsed before receiving either a
     * summaryAck or summaryNack op from the server in response to this
     * summarize attempt. It is expected that the server should respond.
     */
    summaryAckWaitTimeout: "Timeout while waiting for summaryAck/summaryNack op",
    /**
     * The server responded with a summaryNack op, thus rejecting this
     * summarize attempt.
     */
    summaryNack: "Server rejected summary via summaryNack op",
} as const;

export interface ISummarizerRuntime extends IConnectableRuntime {
    readonly logger: ITelemetryLogger;
    readonly deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>;
    readonly summarizerClientId: string | undefined;
    nextSummarizerD?: Deferred<Summarizer>;
    closeFn(): void;
    on(event: "batchEnd", listener: (error: any, op: ISequencedDocumentMessage) => void): this;
    on(event: "disconnected", listener: () => void): this;
    removeListener(event: "batchEnd", listener: (error: any, op: ISequencedDocumentMessage) => void): this;
}

/**
 * Data about a summary attempt
 */
export interface ISummaryAttempt {
    /**
     * Reference sequence number when summary was generated or attempted
     */
    readonly refSequenceNumber: number;

    /**
     * Time of summary attempt after it was sent or attempted
     */
    readonly summaryTime: number;

    /**
     * Sequence number of summary op
     */
    summarySequenceNumber?: number;
}

const checkNotTimeout = <T>(something: T | IPromiseTimerResult | undefined): something is T => {
    if (something === undefined) {
        return false;
    }
    return (something as IPromiseTimerResult).timerResult === undefined;
};

/**
 * This class contains the heuristics for when to summarize.
 */
class SummarizerHeuristics {
    private _lastAttempted: ISummaryAttempt;
    private _lastAcked: ISummaryAttempt;

    /**
     * Last sent summary attempt
     */
    public get lastAttempted(): ISummaryAttempt {
        return this._lastAttempted;
    }

    /**
     * Last acked summary attempt
     */
    public get lastAcked(): ISummaryAttempt {
        return this._lastAcked;
    }

    private readonly idleTimer: Timer;

    public constructor(
        private readonly configuration: ISummaryConfiguration,
        private readonly trySummarize: (reason: SummarizeReason) => void,
        /**
         * Last received op sequence number
         */
        public lastOpSeqNumber: number,
        firstAck: ISummaryAttempt,
    ) {
        this._lastAttempted = firstAck;
        this._lastAcked = firstAck;
        this.idleTimer = new Timer(
            this.configuration.idleTime,
            () => this.trySummarize("idle"));
    }

    /**
     * Sets the last attempted summary and last acked summary.
     * @param lastSummary - last acked summary
     */
    public initialize(lastSummary: ISummaryAttempt) {
        this._lastAttempted = lastSummary;
        this._lastAcked = lastSummary;
    }

    /**
     * Records a summary attempt. If the attempt was successfully sent,
     * provide the reference sequence number, otherwise it will be set
     * to the last seen op sequence number.
     * @param refSequenceNumber - reference sequence number of sent summary
     */
    public recordAttempt(refSequenceNumber?: number) {
        this._lastAttempted = {
            refSequenceNumber: refSequenceNumber ?? this.lastOpSeqNumber,
            summaryTime: Date.now(),
        };
    }

    /**
     * Mark the last sent summary attempt as acked.
     */
    public ackLastSent() {
        this._lastAcked = this.lastAttempted;
    }

    /**
     * Runs the heuristic to determine if it should try to summarize.
     */
    public run() {
        this.idleTimer.clear();
        const timeSinceLastSummary = Date.now() - this.lastAcked.summaryTime;
        const opCountSinceLastSummary = this.lastOpSeqNumber - this.lastAcked.refSequenceNumber;

        if (timeSinceLastSummary > this.configuration.maxTime) {
            this.trySummarize("maxTime");
        } else if (opCountSinceLastSummary > this.configuration.maxOps) {
            this.trySummarize("maxOps");
        } else {
            this.idleTimer.restart();
        }
    }

    /**
     * Disposes of resources.
     */
    public dispose() {
        this.idleTimer.clear();
    }
}

/**
 * An instance of RunningSummarizer manages the heuristics for summarizing.
 * Until disposed, the instance of RunningSummarizer can assume that it is
 * in a state of running, meaning it is connected and initialized.  It keeps
 * track of summaries that it is generating as they are broadcast and acked/nacked.
 */
export class RunningSummarizer implements IDisposable {
    public static async start(
        clientId: string,
        onBehalfOfClientId: string,
        logger: ITelemetryLogger,
        summaryWatcher: IClientSummaryWatcher,
        configuration: ISummaryConfiguration,
        internalsProvider: Pick<ISummarizer, "stop">
            & Pick<ISummarizerInternalsProvider, "generateSummary">,
        lastOpSeqNumber: number,
        firstAck: ISummaryAttempt,
        raiseSummarizingError: (description: string) => void,
        summaryCollection: SummaryCollection,
    ): Promise<RunningSummarizer> {
        const summarizer = new RunningSummarizer(
            clientId,
            onBehalfOfClientId,
            logger,
            summaryWatcher,
            configuration,
            internalsProvider,
            lastOpSeqNumber,
            firstAck,
            raiseSummarizingError,
            summaryCollection);

        await summarizer.waitStart();

        // Run the heuristics after starting
        summarizer.heuristics.run();
        return summarizer;
    }

    public get disposed() { return this._disposed; }

    private stopping = false;
    private _disposed = false;
    private summarizing: Deferred<void> | undefined;
    private summarizeCount: number = 0;
    private tryWhileSummarizing = false;
    private readonly summarizeTimer: Timer;
    private readonly pendingAckTimer: PromiseTimer;
    private readonly heuristics: SummarizerHeuristics;
    private readonly logger: ITelemetryLogger;

    private constructor(
        private readonly clientId: string,
        private readonly onBehalfOfClientId: string,
        baseLogger: ITelemetryLogger,
        private readonly summaryWatcher: IClientSummaryWatcher,
        private readonly configuration: ISummaryConfiguration,
        private readonly internalsProvider: Pick<ISummarizer, "stop">
            & Pick<ISummarizerInternalsProvider, "generateSummary">,
        lastOpSeqNumber: number,
        firstAck: ISummaryAttempt,
        private readonly raiseSummarizingError: (description: string) => void,
        private readonly summaryCollection: SummaryCollection,
    ) {
        this.logger = ChildLogger.create(
            baseLogger, "Running", { all: { summaryGenTag: () => this.summarizeCount } });

        this.heuristics = new SummarizerHeuristics(
            configuration,
            (reason) => this.trySummarize(reason),
            lastOpSeqNumber,
            firstAck);

        this.summarizeTimer = new Timer(
            maxSummarizeTimeoutTime,
            () => this.summarizeTimerHandler(maxSummarizeTimeoutTime, 1));

        // Cap the maximum amount of time client will wait for a summarize op ack to maxSummarizeAckWaitTime
        const maxAckWaitTime = Math.min(this.configuration.maxAckWaitTime, maxSummarizeAckWaitTime);

        this.pendingAckTimer = new PromiseTimer(
            maxAckWaitTime,
            () => {
                this.raiseSummarizingError("SummaryAckWaitTimeout");
                // Note: summaryGenTag (from ChildLogger definition) may be 0,
                // since this code path is hit when RunningSummarizer first starts up,
                // before this instance has kicked off a new summarize run.
                this.logger.sendErrorEvent({
                    eventName: "SummaryAckWaitTimeout",
                    maxAckWaitTime,
                    refSequenceNumber: this.heuristics.lastAttempted.refSequenceNumber,
                    summarySequenceNumber: this.heuristics.lastAttempted.summarySequenceNumber,
                    timePending: Date.now() - this.heuristics.lastAttempted.summaryTime,
                });
            });
        // Set up pending ack timeout by op timestamp differences for previous summaries.
        summaryCollection.setPendingAckTimerTimeoutCallback(maxAckWaitTime, () => {
            if (this.pendingAckTimer.hasTimer) {
                this.logger.sendTelemetryEvent({
                    eventName: "MissingSummaryAckFoundByOps",
                    refSequenceNumber: this.heuristics.lastAttempted.refSequenceNumber,
                    summarySequenceNumber: this.heuristics.lastAttempted.summarySequenceNumber,
                });
                this.pendingAckTimer.clear();
            }
        });
    }

    public dispose(): void {
        this.summaryWatcher.dispose();
        this.heuristics.dispose();
        this.summarizeTimer.clear();
        this.pendingAckTimer.clear();
        this._disposed = true;
    }

    /**
     * RunningSummarizer's logger includes the sequenced index of the current summary on each event.
     * If some other Summarizer code wants that event on their logs they can get it here,
     * but only if they're logging about that same summary.
     * @param summaryOpRefSeq - RefSeq number of the summary op, to ensure the log correlation will be correct
     */
    public tryGetCorrelatedLogger = (summaryOpRefSeq) =>
        this.heuristics.lastAttempted.refSequenceNumber === summaryOpRefSeq
            ? this.logger
            : undefined;

    public handleSystemOp(op: ISequencedDocumentMessage) {
        switch (op.type) {
            case MessageType.ClientLeave: {
                const leavingClientId = JSON.parse((op as ISequencedDocumentSystemMessage).data) as string;
                if (leavingClientId === this.clientId || leavingClientId === this.onBehalfOfClientId) {
                    // Ignore summarizer leave messages, to make sure not to start generating
                    // a summary as the summarizer is leaving
                    return;
                }
                // Leave ops for any other client fall through to handle normally
            }
            // Intentional fallthrough
            case MessageType.ClientJoin:
            case MessageType.Propose:
            case MessageType.Reject: {
                // Synchronously handle quorum ops like regular ops
                this.handleOp(undefined, op);
                return;
            }
            default: {
                return;
            }
        }
    }

    public handleOp(error: any, op: ISequencedDocumentMessage) {
        if (error !== undefined) {
            return;
        }
        this.heuristics.lastOpSeqNumber = op.sequenceNumber;

        // Check for ops requesting summary
        if (op.type === MessageType.Save) {
            // TODO: cast is only required until TypeScript version 4.3
            this.trySummarize(`save;${op.clientId}: ${op.contents}` as `save;${string}: ${string}`);
        } else {
            this.heuristics.run();
        }
    }

    public async waitStop(): Promise<void> {
        if (this.disposed) {
            return;
        }
        if (this.stopping) {
            await this.summarizing?.promise;
            return;
        }
        this.stopping = true;
        const outstandingOps = this.heuristics.lastOpSeqNumber - this.heuristics.lastAcked.refSequenceNumber;
        if (outstandingOps > minOpsForLastSummary) {
            this.trySummarize("lastSummary");
            // This resolves when the current pending summary is acked or fails.
            // We wait for the result in case a safe summary is needed, and to get
            // better telemetry.
            await this.summarizing?.promise;
        }
    }

    private async waitStart() {
        // Wait no longer than ack timeout for all pending
        const maybeLastAck = await Promise.race([
            this.summaryWatcher.waitFlushed(),
            this.pendingAckTimer.start(),
        ]);
        this.pendingAckTimer.clear();

        // Remove pending ack wait timeout by op timestamp comparison, because
        // it has race conditions with summaries submitted by this same client.
        this.summaryCollection.unsetPendingAckTimerTimeoutCallback();

        if (checkNotTimeout(maybeLastAck)) {
            this.heuristics.initialize({
                refSequenceNumber: maybeLastAck.summaryOp.referenceSequenceNumber,
                summaryTime: maybeLastAck.summaryOp.timestamp,
                summarySequenceNumber: maybeLastAck.summaryOp.sequenceNumber,
            });
        }
    }

    private trySummarize(reason: SummarizeReason): void {
        if (this.summarizing !== undefined) {
            // We can't summarize if we are already
            this.tryWhileSummarizing = true;
            return;
        }

        // GenerateSummary could take some time
        // mark that we are currently summarizing to prevent concurrent summarizing
        this.summarizing = new Deferred<void>();

        (async () => {
            if (await this.summarize(reason, { refreshLatestAck: false, fullTree: false })) {
                return;
            }
            // On nack or error, try again fetching latest from storage server
            if (await this.summarize("retry1", { refreshLatestAck: true, fullTree: false })) {
                return;
            }
            // On another failure, run the full tree
            if (await this.summarize("retry2", { refreshLatestAck: true, fullTree: true })) {
                return;
            }
            // If all 3 attempts failed, close the summarizer container
            this.logger.sendErrorEvent({ eventName: "FailToSummarize" });
            this.internalsProvider.stop("failToSummarize");
        })().finally(() => {
            this.summarizing?.resolve();
            this.summarizing = undefined;
            if (this.tryWhileSummarizing && !this.stopping && !this.disposed) {
                this.tryWhileSummarizing = false;
                this.heuristics.run();
            }
        }).catch((error) => {
            this.logger.sendErrorEvent({ eventName: "UnexpectedSummarizeError" }, error);
        });
    }

    /**
     * Generates summary and listens for broadcast and ack/nack.
     * Returns true for ack, false for nack, and undefined for failure or timeout.
     * @param reason - reason for summarizing
     * @param options - refreshLatestAck to fetch summary ack info from server,
     * fullTree to generate tree without any summary handles even if unchanged
     */
    private async summarize(
        reason: SummarizeReason,
        options: Omit<IGenerateSummaryOptions, "summaryLogger">,
    ): Promise<boolean> {
        ++this.summarizeCount;
        const { refreshLatestAck, fullTree } = options;

        const summarizeEvent = PerformanceEvent.start(this.logger, {
            eventName: "Summarize",
            reason,
            refreshLatestAck,
            fullTree,
            timeSinceLastAttempt: Date.now() - this.heuristics.lastAttempted.summaryTime,
            timeSinceLastSummary: Date.now() - this.heuristics.lastAcked.summaryTime,
        });
        // Helper function to report failures and return.
        const fail = (
            message: keyof typeof summarizeErrors,
            error?: any,
            properties?: ITelemetryProperties,
        ): false => {
            this.raiseSummarizingError(summarizeErrors[message]);
            summarizeEvent.cancel({ ...properties, message }, error);
            return false;
        };

        // Wait to generate and send summary
        this.summarizeTimer.start();
        let summaryData: GenerateSummaryData | undefined;
        try {
            summaryData = await this.internalsProvider.generateSummary({
                fullTree,
                refreshLatestAck,
                summaryLogger: this.logger,
            });

            const {
                summaryStats,
                referenceSequenceNumber,
                ...summaryDataForTelemetry
            } = summaryData;
            // Use record type to prevent unexpected value types
            const telemetryProps: Record<string, string | number | boolean | undefined> = {
                ...summaryDataForTelemetry,
                ...summaryStats,
                refSequenceNumber: referenceSequenceNumber,
                opsSinceLastAttempt: referenceSequenceNumber - this.heuristics.lastAttempted.refSequenceNumber,
                opsSinceLastSummary: referenceSequenceNumber - this.heuristics.lastAcked.refSequenceNumber,
            };
            this.logger.sendTelemetryEvent({
                eventName: "GenerateSummary",
                ...telemetryProps,
            });
        } catch (error) {
            return fail("generateSummaryFailure", error);
        } finally {
            this.heuristics.recordAttempt(summaryData?.referenceSequenceNumber);
            this.summarizeTimer.clear();
        }

        if (!summaryData.submitted) {
            // Did not send the summary op
            return fail("generateSummaryFailure", summaryData.error);
        }

        try {
            const pendingTimeoutP = this.pendingAckTimer.start().catch(() => undefined);
            const summary = this.summaryWatcher.watchSummary(summaryData.clientSequenceNumber);

            // Wait for broadcast
            const summaryOp = await Promise.race([summary.waitBroadcast(), pendingTimeoutP]);
            if (!checkNotTimeout(summaryOp)) {
                return fail("summaryOpWaitTimeout");
            }
            this.heuristics.lastAttempted.summarySequenceNumber = summaryOp.sequenceNumber;
            this.logger.sendTelemetryEvent({
                eventName: "SummaryOp",
                timeWaiting: Date.now() - this.heuristics.lastAttempted.summaryTime,
                refSequenceNumber: summaryOp.referenceSequenceNumber,
                summarySequenceNumber: summaryOp.sequenceNumber,
                handle: summaryOp.contents.handle,
            });

            // Wait for ack/nack
            const ackNack = await Promise.race([summary.waitAckNack(), pendingTimeoutP]);
            if (!checkNotTimeout(ackNack)) {
                return fail("summaryAckWaitTimeout");
            }
            this.pendingAckTimer.clear();

            // Update for success/failure
            const telemetryProps: Record<string, number> = {
                timeWaiting: Date.now() - this.heuristics.lastAttempted.summaryTime,
                sequenceNumber: ackNack.sequenceNumber,
                summarySequenceNumber: ackNack.contents.summaryProposal.summarySequenceNumber,
            };
            if (ackNack.type === MessageType.SummaryAck) {
                this.heuristics.ackLastSent();
                summarizeEvent.end({ ...telemetryProps, handle: ackNack.contents.handle, message: "summaryAck" });
                return true;
            } else {
                return fail(
                    "summaryNack",
                    ackNack.contents.errorMessage,
                    telemetryProps,
                );
            }
        } finally {
            this.pendingAckTimer.clear();
        }
    }

    private summarizeTimerHandler(time: number, count: number) {
        this.logger.sendPerformanceEvent({
            eventName: "SummarizeTimeout",
            timeoutTime: time,
            timeoutCount: count,
        });
        if (count < maxSummarizeTimeoutCount) {
            // Double and start a new timer
            const nextTime = time * 2;
            this.summarizeTimer.start(nextTime, () => this.summarizeTimerHandler(nextTime, count + 1));
        }
    }
}

/**
 * Summarizer is responsible for coordinating when to send generate and send summaries.
 * It is the main entry point for summary work.
 */
export class Summarizer extends EventEmitter implements ISummarizer {
    public get IFluidLoadable() { return this; }
    public get IFluidRouter() { return this; }
    public get IFluidRunnable() { return this; }
    public get ISummarizer() { return this; }

    private readonly logger: ITelemetryLogger;
    private readonly runCoordinator: RunWhileConnectedCoordinator;
    private onBehalfOfClientId: string | undefined;
    private runningSummarizer?: RunningSummarizer;
    private systemOpListener?: (op: ISequencedDocumentMessage) => void;
    private opListener?: (error: any, op: ISequencedDocumentMessage) => void;
    private stopped = false;
    private readonly stopDeferred = new Deferred<void>();
    private _disposed: boolean = false;

    private readonly innerHandle: IFluidHandle<this>;

    public get handle(): IFluidHandle<this> { return this.innerHandle; }

    constructor(
        url: string,
        private readonly runtime: ISummarizerRuntime,
        private readonly configurationGetter: () => ISummaryConfiguration,
        private readonly internalsProvider: ISummarizerInternalsProvider,
        handleContext: IFluidHandleContext,
        public readonly summaryCollection: SummaryCollection,
    ) {
        super();
        this.logger = ChildLogger.create(this.runtime.logger, "Summarizer");
        this.runCoordinator = new RunWhileConnectedCoordinator(runtime);
        this.innerHandle = new SummarizerHandle(this, url, handleContext);
    }

    public async run(onBehalfOf: string): Promise<void> {
        try {
            await this.runCore(onBehalfOf);
        } catch (error) {
            this.emit("summarizingError", SummarizingWarning.wrap(error, false /* logged */));
            throw error;
        } finally {
            // Cleanup after running
            if (this.runtime.connected) {
                if (this.runningSummarizer) {
                    await this.runningSummarizer.waitStop();
                }
                this.runtime.closeFn();
            }
            this.dispose();
        }
    }

    /**
     * Stops the summarizer from running.  This will complete
     * the run promise, and also close the container.
     * @param reason - reason code for stopping
     */
    public stop(reason?: SummarizerStopReason) {
        if (this.stopped) {
            // already stopping
            return;
        }
        this.stopped = true;

        this.logger.sendTelemetryEvent({
            eventName: "StoppingSummarizer",
            onBehalfOf: this.onBehalfOfClientId,
            reason,
        });
        this.stopDeferred.resolve();
    }

    public updateOnBehalfOf(onBehalfOf: string): void {
        this.onBehalfOfClientId = onBehalfOf;
    }

    public async request(request: IRequest): Promise<IResponse> {
        if (request.url === "/" || request.url === "") {
            return {
                mimeType: "fluid/object",
                status: 200,
                value: this,
            };
        }
        return create404Response(request);
    }

    private async runCore(onBehalfOf: string): Promise<void> {
        this.onBehalfOfClientId = onBehalfOf;

        const startResult = await this.runCoordinator.waitStart();
        if (startResult.started === false) {
            this.logger.sendTelemetryEvent({
                eventName: "NotStarted",
                reason: startResult.message,
                onBehalfOf,
            });
            return;
        }

        if (this.runtime.deltaManager.active === false) {
            this.logger.sendTelemetryEvent({
                eventName: "NotStarted",
                reason: "CannotWrite",
                onBehalfOf,
            });
            return;
        }

        if (this.runtime.summarizerClientId !== this.onBehalfOfClientId
            && this.runtime.summarizerClientId !== this.runtime.clientId) {
            // Verify that this client's computed summarizer matches the client this was spawned
            // on behalf of.  If not, fallback on the following logic before stopping:
            // If we are not oldest client in quorum, another client will take over as summarizer.
            // We want to make sure we at least try to summarize in case server is rejecting ops,
            // so if we are the oldest client, we will still go through and try to summarize at least once.
            // We also don't want to end up with two summarizer clients running at the same time,
            // so we bypass running altogether if this client isn't the oldest.
            this.logger.sendTelemetryEvent({
                eventName: "NotStarted",
                reason: "DifferentComputedSummarizer",
                computedSummarizer: this.runtime.summarizerClientId,
                onBehalfOf,
                clientId: this.runtime.clientId,
            });
            return;
        }

        // Initialize values and first ack (time is not exact)
        this.logger.sendTelemetryEvent({
            eventName: "RunningSummarizer",
            onBehalfOf,
            initSummarySeqNumber: this.runtime.deltaManager.initialSequenceNumber,
        });

        const initialAttempt: ISummaryAttempt = {
            refSequenceNumber: this.runtime.deltaManager.initialSequenceNumber,
            summaryTime: Date.now(),
        };

        const runningSummarizer = await RunningSummarizer.start(
            startResult.clientId,
            onBehalfOf,
            this.logger,
            this.summaryCollection.createWatcher(startResult.clientId),
            this.configurationGetter(),
            this /* Pick<ISummarizerInternalsProvider, "generateSummary"> */,
            this.runtime.deltaManager.lastSequenceNumber,
            initialAttempt,
            (description: string) => {
                if (!this._disposed) {
                    this.emit("summarizingError", createSummarizingWarning(`Summarizer: ${description}`, true));
                }
            },
            this.summaryCollection,
        );
        this.runningSummarizer = runningSummarizer;

        // Handle summary acks
        this.handleSummaryAcks().catch((error) => {
            this.logger.sendErrorEvent({ eventName: "HandleSummaryAckFatalError" }, error);

            // Raise error to parent container.
            this.emit("summarizingError", createSummarizingWarning("Summarizer: HandleSummaryAckFatalError", true));

            this.stop();
        });

        // Listen for ops
        this.systemOpListener = (op: ISequencedDocumentMessage) => runningSummarizer.handleSystemOp(op);
        this.runtime.deltaManager.inbound.on("op", this.systemOpListener);

        this.opListener = (error: any, op: ISequencedDocumentMessage) => runningSummarizer.handleOp(error, op);
        this.runtime.on("batchEnd", this.opListener);

        await Promise.race([
            this.runCoordinator.waitStopped(),
            this.stopDeferred.promise,
        ]);
    }

    /**
     * Disposes of resources after running.  This cleanup will
     * clear any outstanding timers and reset some of the state
     * properties.
     */
    public dispose() {
        this._disposed = true;
        if (this.runningSummarizer) {
            this.runningSummarizer.dispose();
            this.runningSummarizer = undefined;
        }
        if (this.systemOpListener) {
            this.runtime.deltaManager.inbound.off("op", this.systemOpListener);
        }
        if (this.opListener) {
            this.runtime.removeListener("batchEnd", this.opListener);
        }
    }

    public async setSummarizer(): Promise<Summarizer> {
        this.runtime.nextSummarizerD = new Deferred<Summarizer>();
        return this.runtime.nextSummarizerD.promise;
    }

    /** Implementation of SummarizerInternalsProvider.generateSummary */
    public async generateSummary(options: IGenerateSummaryOptions): Promise<GenerateSummaryData> {
        const result = this.internalsProvider.generateSummary(options);

        if (this.onBehalfOfClientId !== this.runtime.summarizerClientId
            && this.runtime.clientId !== this.runtime.summarizerClientId) {
            // We are no longer the summarizer; a different client is, so we should stop ourself
            this.stop("parentNoLongerSummarizer");
        }
        return result;
    }

    private async handleSummaryAcks() {
        let refSequenceNumber = this.runtime.deltaManager.initialSequenceNumber;
        while (this.runningSummarizer) {
            const summaryLogger = this.runningSummarizer.tryGetCorrelatedLogger(refSequenceNumber) ?? this.logger;
            try {
                const ack = await this.summaryCollection.waitSummaryAck(refSequenceNumber);
                refSequenceNumber = ack.summaryOp.referenceSequenceNumber;

                await this.internalsProvider.refreshLatestSummaryAck(
                    ack.summaryOp.contents.handle,
                    ack.summaryAck.contents.handle,
                    summaryLogger,
                );
            } catch (error) {
                summaryLogger.sendErrorEvent({ eventName: "HandleSummaryAckError", refSequenceNumber }, error);
            }
            refSequenceNumber++;
        }
    }
}
