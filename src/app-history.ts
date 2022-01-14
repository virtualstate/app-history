import {
    AppHistoryEntry,
    AppHistoryEntryInit,
    AppHistoryEntryKnownAs,
    AppHistoryEntryNavigationType, AppHistoryEntrySetState
} from "./app-history-entry";
import {
    AppHistory as AppHistoryPrototype,
    AppHistoryEventMap,
    AppHistoryReloadOptions,
    AppHistoryResult,
    AppHistoryUpdateCurrentOptions,
    AppHistoryTransition as AppHistoryTransitionPrototype,
    AppHistoryCurrentChangeEvent,
    AppHistoryNavigationOptions
} from "./spec/app-history";
import {AppHistoryEventTarget} from "./app-history-event-target";
import {InvalidStateError} from "./app-history-errors";
import {EventTargetListeners} from "./event-target";
import {
    AppHistoryTransition,
    AppHistoryTransitionEntry,
    AppHistoryTransitionError,
    AppHistoryTransitionFinally,
    AppHistoryTransitionStart,
    AppHistoryTransitionInitialEntries,
    AppHistoryTransitionInitialIndex,
    AppHistoryTransitionKnown,
    AppHistoryTransitionNavigationType,
    AppHistoryTransitionParentEventTarget,
    AppHistoryTransitionPromises,
    AppHistoryTransitionWait,
    InternalAppHistoryNavigationType,
    Rollback,
    Unset,
    AppHistoryTransitionWhile,
    AppHistoryTransitionStartDeadline,
    AppHistoryTransitionCommit,
    AppHistoryTransitionFinish,
    AppHistoryTransitionAbort,
    AppHistoryTransitionIsOngoing,
    AppHistoryTransitionFinishedDeferred, AppHistoryTransitionCommittedDeferred
} from "./app-history-transition";
import {
    AppHistoryTransitionResult,
    createAppHistoryTransition,
    EventAbortController,
    InternalAppHistoryNavigateOptions,
    AppHistoryNavigateOptions,
    isAppHistoryNavigationType
} from "./create-app-history-transition";
import {createEvent} from "./event-target/create-event";

export * from "./spec/app-history";

export interface AppHistoryOptions {
    initialUrl?: URL | string;
}

const baseUrl = "https://html.spec.whatwg.org/";

export class AppHistory extends AppHistoryEventTarget<AppHistoryEventMap> implements AppHistoryPrototype {

    // Should be always 0 or 1
    #transitionInProgressCount = 0;

    #entries: AppHistoryEntry[] = [];
    #known = new Set<AppHistoryEntry>();
    #currentIndex = -1;
    #activePromise?: Promise<unknown>;
    #activeTransition?: AppHistoryTransition;
    //
    // #upcomingNonTraverseTransition: AppHistoryTransition;

    #knownTransitions = new WeakSet();
    #initialUrl: string;

    get canGoBack() {
       return !!this.#entries[this.#currentIndex - 1];
    };

    get canGoForward() {
        return !!this.#entries[this.#currentIndex + 1];
    };

    get current() {
        if (this.#currentIndex === -1) {
            return undefined;
        }
        return this.#entries[this.#currentIndex];
    };

    get transition(): AppHistoryTransitionPrototype | undefined {
        return this.#activeTransition;
    };

    constructor(options?: AppHistoryOptions) {
        super();
        const initialUrl = options?.initialUrl ?? "/";
        this.#initialUrl = (typeof initialUrl === "string" ? new URL(initialUrl, baseUrl) : initialUrl).toString();
    }

    back(options?: AppHistoryNavigationOptions): AppHistoryResult {
        if (!this.canGoBack) throw new InvalidStateError("Cannot go back");
        const entry = this.#entries[this.#currentIndex - 1];
        return this.#pushEntry("traverse", this.#cloneAppHistoryEntry(entry, {
            ...options,
            navigationType: "traverse"
        }));
    }

    entries(): AppHistoryEntry[] {
        return [...this.#entries];
    }

    forward(options?: AppHistoryNavigationOptions): AppHistoryResult {
        if (!this.canGoForward) throw new InvalidStateError();
        const entry = this.#entries[this.#currentIndex + 1];
        return this.#pushEntry("traverse", this.#cloneAppHistoryEntry(entry, {
            ...options,
            navigationType: "traverse"
        }));
    }

    goTo(key: string, options?: AppHistoryNavigationOptions): AppHistoryResult {
        const found = this.#entries.find(entry => entry.key === key);
        if (found) {
            return this.#pushEntry("traverse", this.#cloneAppHistoryEntry(found, {
                ...options,
                navigationType: "traverse"
            }));
        }
        throw new InvalidStateError();
    }

    navigate(url: string, options?: AppHistoryNavigateOptions): AppHistoryResult {
        const nextUrl = new URL(url, this.#initialUrl).toString();
        const navigationType: InternalAppHistoryNavigationType = options?.replace ? "replace" : "default";
        const nextOptions: InternalAppHistoryNavigateOptions = {
            ...options
        };
        const entry = this.#createAppHistoryEntry({
            url: nextUrl,
            ...nextOptions,
            navigationType: isAppHistoryNavigationType(navigationType) ? navigationType : "push"
        });
        return this.#pushEntry(
            navigationType,
            entry,
            undefined,
            nextOptions
        );
    }

    #cloneAppHistoryEntry = (entry?: AppHistoryEntry, options?: InternalAppHistoryNavigateOptions): AppHistoryEntry => {
        return this.#createAppHistoryEntry({
            ...entry,
            index: entry?.index ?? undefined,
            state: options?.state ?? entry?.getState() ?? {},
            navigationType: entry?.[AppHistoryEntryNavigationType] ?? (typeof options?.navigationType === "string" ? options.navigationType : "replace"),
            ...options,
            get [AppHistoryEntryKnownAs]() {
              return entry?.[AppHistoryEntryKnownAs];
            },
            get [EventTargetListeners]() {
                return entry?.[EventTargetListeners];
            }
        });
    }

    #createAppHistoryEntry = (options: Partial<AppHistoryEntryInit> & Omit<AppHistoryEntryInit, "index">) => {
        const entry: AppHistoryEntry = new AppHistoryEntry({
            ...options,
            index: options.index ?? (() => {
                return this.#entries.indexOf(entry);
            }),
        });
        return entry;

    }

    #pushEntry = (navigationType: InternalAppHistoryNavigationType, entry: AppHistoryEntry, transition?: AppHistoryTransition, options?: InternalAppHistoryNavigateOptions) => {
        /* c8 ignore start */
        if (entry === this.current) throw new InvalidStateError();
        const existingPosition = this.#entries.findIndex(existing => existing.id === entry.id);
        if (existingPosition > -1) {
            throw new InvalidStateError();
        }
        /* c8 ignore end */
        return this.#commitTransition(navigationType, entry, transition, options);
    };

    #commitTransition = (givenNavigationType: InternalAppHistoryNavigationType, entry: AppHistoryEntry,  transition?: AppHistoryTransition, options?: InternalAppHistoryNavigateOptions) => {
        const nextTransition: AppHistoryTransition = transition ?? new AppHistoryTransition({
            from: entry,
            navigationType: isAppHistoryNavigationType(givenNavigationType) ? givenNavigationType : "push",
            rollback: (options) => {
                return this.#rollback(nextTransition, options);
            },
            [AppHistoryTransitionNavigationType]: givenNavigationType,
            [AppHistoryTransitionInitialEntries]: [...this.#entries],
            [AppHistoryTransitionInitialIndex]: this.#currentIndex,
            [AppHistoryTransitionKnown]: [...this.#known],
            [AppHistoryTransitionEntry]: entry,
            [AppHistoryTransitionParentEventTarget]: this
        });
        const { finished, committed } = nextTransition;
        const handler = () => {
            return this.#immediateTransition(givenNavigationType, entry, nextTransition, options);
        };
        void handler().catch(error => void error);
        // const previousPromise = this.#activePromise;
        // let nextPromise;
        // // console.log({ givenNavigationType });
        // if (givenNavigationType === Rollback) {
        //     nextPromise = handler().then(() => previousPromise);
        // } else {
        //     if (previousPromise) {
        //         nextPromise = previousPromise.then(handler);
        //     } else {
        //         nextPromise = handler();
        //     }
        // }
        // console.log({ previousPromise, nextPromise });
        // const promise = nextPromise
        //     .catch(error => void error)
        //     .then(() => {
        //         if (this.#activePromise === promise) {
        //             this.#activePromise = undefined;
        //         }
        //     })
        this.#queueTransition(nextTransition);
        return { committed, finished };

    }

    #queueTransition = (transition: AppHistoryTransition) => {
        // TODO consume errors that are not abort errors
        // transition.finished.catch(error => void error);
        this.#knownTransitions.add(transition);
    }

    #immediateTransition = (givenNavigationType: InternalAppHistoryNavigationType, entry: AppHistoryEntry, transition: AppHistoryTransition, options?: InternalAppHistoryNavigateOptions) => {
        try {
            this.#transitionInProgressCount += 1;
            if (this.#transitionInProgressCount > 1 && !(givenNavigationType === Rollback)) {
                throw new InvalidStateError("Unexpected multiple transitions");
            }
            return this.#transition(givenNavigationType, entry, transition, options);
        } finally {
            this.#transitionInProgressCount -= 1;
        }
    }

    #rollback = (rollbackTransition: AppHistoryTransition, options?: AppHistoryNavigationOptions): AppHistoryResult => {
        const previousEntries = rollbackTransition[AppHistoryTransitionInitialEntries];
        const previousIndex = rollbackTransition[AppHistoryTransitionInitialIndex];
        const previousCurrent = previousEntries[previousIndex];
        // console.log("z");
        // console.log("Rollback!", { previousCurrent, previousEntries, previousIndex });
        const entry = previousCurrent ? this.#cloneAppHistoryEntry(previousCurrent, options) : undefined;
        const nextOptions: InternalAppHistoryNavigateOptions = {
            ...options,
            index: previousIndex,
            known: new Set([...this.#known, ...previousEntries]),
            navigationType: entry?.[AppHistoryEntryNavigationType] ?? "replace",
            entries: previousEntries,
        } as const;
        const resolvedNavigationType = entry ? Rollback : Unset
        const resolvedEntry = entry ?? this.#createAppHistoryEntry({
            navigationType: "replace",
            index: nextOptions.index,
            sameDocument: true,
            ...options,
        });
        return this.#pushEntry(resolvedNavigationType, resolvedEntry, undefined, nextOptions);
    }

    #transition = (givenNavigationType: InternalAppHistoryNavigationType, entry: AppHistoryEntry, transition: AppHistoryTransition, options?: InternalAppHistoryNavigateOptions): Promise<AppHistoryEntry> => {
        // console.log({ givenNavigationType, transition });
        let navigationType = givenNavigationType;

        const performance = getPerformance();

        if (entry.sameDocument && typeof navigationType === "string") {
            performance.mark(`same-document-navigation:${entry.id}`);
        }

        let committed = false;

        const { current } = this;
        const transitionResult = createAppHistoryTransition({
            current,
            currentIndex: this.#currentIndex,
            options,
            transition,
            known: this.#known
        });
        void this.#activeTransition?.finished?.catch(error => error);
        void this.#activeTransition?.[AppHistoryTransitionFinishedDeferred]?.promise?.catch(error => error);
        void this.#activeTransition?.[AppHistoryTransitionCommittedDeferred]?.promise?.catch(error => error);
        this.#activeTransition?.[AppHistoryTransitionAbort]();
        this.#activeTransition = transition;

        const startEventPromise = transition.dispatchEvent({
            type: AppHistoryTransitionStart,
            transition,
            entry
        });

        const unsetTransition = async () => {
            await startEventPromise;
            if (!(typeof options?.index === "number" && options.entries)) throw new InvalidStateError();
            await asyncCommit({
                entries: options.entries,
                index: options.index,
                known: options.known,
            });
            await this.dispatchEvent(
                createEvent({
                    type: "currentchange"
                })
            );
            committed = true;
            return entry;
        }


        const completeTransition = (): Promise<AppHistoryEntry> => {
            if (givenNavigationType === Unset) {
                return unsetTransition();
            }

            const microtask = new Promise<void>(queueMicrotask);
            let promises: Promise<unknown>[] = [];
            const iterator = transitionSteps(transitionResult)[Symbol.iterator]();
            const iterable = { [Symbol.iterator]: () => ({ next: () => iterator.next() })};

            function syncTransition() {
                for (const promise of iterable) {
                    if (promise && typeof promise === "object" && "then" in promise) {
                        promises.push(promise);
                        void promise.catch(error => error);
                    }
                    if (committed) {
                        return asyncTransition();
                    }
                    if (transition.signal.aborted) {
                        break;
                    }
                }
                return Promise.resolve(); // We got through with no async
            }
            async function asyncTransition(): Promise<void> {
                const captured = [...promises];
                if (captured.length) {
                    promises = [];
                    await Promise.all(captured);
                } else if (!transition[AppHistoryTransitionIsOngoing]) {
                    await microtask;
                }
                return syncTransition();
            }

            // console.log("Returning", { entry });
            return syncTransition()
                .then(() => transition[AppHistoryTransitionIsOngoing] ? undefined : microtask)
                .then(() => entry);
        }

        interface Commit  {
            entries: AppHistoryEntry[];
            index: number;
            known?: Set<AppHistoryEntry>;
        }

        const syncCommit = ({ entries, index, known }: Commit) => {
            if (transition.signal.aborted) return;
            this.#entries = entries.filter(Boolean);
            if (known) {
                this.#known = new Set([...this.#known, ...(known)])
            }
            this.#currentIndex = index;
        }

        const asyncCommit = (commit: Commit) => {
            syncCommit(commit);
            return transition.dispatchEvent(
                createEvent(
                    {
                        type: AppHistoryTransitionCommit,
                        transition,
                        entry
                    }
                )
            );
        }

        const dispose = async () => this.#dispose();

        function *transitionSteps(transitionResult: AppHistoryTransitionResult): Iterable<Promise<unknown>> {
            const microtask = new Promise<void>(queueMicrotask);
            const {
                known,
                entries,
                index,
                currentChange,
                navigate,
            } = transitionResult;

            const navigateAbort = navigate[EventAbortController].abort.bind(navigate[EventAbortController]);
            transition.signal.addEventListener("abort", navigateAbort, { once: true });

            if (typeof navigationType === "string" || navigationType === Rollback) {
                const promise = current?.dispatchEvent(
                    createEvent({
                        type: "navigatefrom",
                        transitionWhile: transition[AppHistoryTransitionWhile],
                    })
                );
                if (promise) yield promise;
            }

            if (typeof navigationType === "string") {
                yield transition.dispatchEvent(navigate);
            }

            yield asyncCommit({
                entries: entries,
                index: index,
                known: known,
            });
            if (entry.sameDocument) {
                yield transition.dispatchEvent(currentChange);
            }
            committed = true;
            if (typeof navigationType === "string") {
                yield entry.dispatchEvent(
                    createEvent({
                        type: "navigateto",
                        transitionWhile: transition[AppHistoryTransitionWhile],
                    })
                );
            }
            yield dispose();
            if (!transition[AppHistoryTransitionPromises].size) {
                yield microtask;
            }
            yield transition.dispatchEvent({
                type: AppHistoryTransitionStartDeadline,
                transition,
                entry
            });
            yield transition[AppHistoryTransitionWait]();
            transition.signal.removeEventListener("abort", navigateAbort);
            yield transition.dispatchEvent({
                type: AppHistoryTransitionFinish,
                transition,
                entry,
                transitionWhile: transition[AppHistoryTransitionWhile]
            });
            if (typeof navigationType === "string") {
                yield transition.dispatchEvent(
                    createEvent({
                        type: "finish",
                        transitionWhile: transition[AppHistoryTransitionWhile]
                    })
                );
            }
            if (typeof navigationType === "string") {
                yield transition.dispatchEvent(
                    createEvent({
                        type: "navigatesuccess",
                        transitionWhile: transition[AppHistoryTransitionWhile]
                    })
                );
            }
            // If we have more length here, we have added more transition
            yield transition[AppHistoryTransitionWait]();
        }

        const maybeSyncTransition = () => {
            try {
                return completeTransition();
            } catch (error) {
                return Promise.reject(error);
            }
        }

        return Promise.allSettled([
            maybeSyncTransition()
        ])
            .then(async ([detail]) => {
                if (detail.status === "rejected") {
                    await transition.dispatchEvent({
                        type: AppHistoryTransitionError,
                        error: detail.reason,
                        transition,
                        entry
                    });
                }

                await dispose();
                await transition.dispatchEvent({
                    type: AppHistoryTransitionFinally,
                    transition,
                    entry
                });
                await transition[AppHistoryTransitionWait]();
                if (this.#activeTransition === transition) {
                    this.#activeTransition = undefined;
                }
                if (entry.sameDocument && typeof navigationType === "string") {
                    performance.mark(`same-document-navigation-finish:${entry.id}`);
                    performance.measure(
                        `same-document-navigation:${entry.url}`,
                        `same-document-navigation:${entry.id}`,
                        `same-document-navigation-finish:${entry.id}`
                    );
                }
            })
            .then(() => entry)
    }

    #dispose = async () => {
        // console.log(JSON.stringify({ known: [...this.#known], entries: this.#entries }));
        for (const known of this.#known) {
            const index = this.#entries.findIndex(entry => entry.key === known.key);
            if (index !== -1) {
                // Still in use
                continue;
            }
            // No index, no longer known
            this.#known.delete(known);
            const event = createEvent({
                type: "dispose",
                entry: known
            });
            await known.dispatchEvent(event);
            await this.dispatchEvent(event);
        }
        // console.log(JSON.stringify({ pruned: [...this.#known] }));
    }

    reload(options?: AppHistoryReloadOptions): AppHistoryResult {
        const { current } = this;
        if (!current) throw new InvalidStateError();
        const entry = this.#cloneAppHistoryEntry(current, options);
        return this.#pushEntry("reload", entry, undefined, options);
    }

    updateCurrent(options: AppHistoryUpdateCurrentOptions): Promise<void>
    updateCurrent(options: AppHistoryUpdateCurrentOptions): void
    updateCurrent(options: AppHistoryUpdateCurrentOptions): unknown {
        const { current } = this;

        if (!current) {
            throw new InvalidStateError("Expected current entry");
        }

        // Instant change
        current[AppHistoryEntrySetState](options.state);

        const currentChange: AppHistoryCurrentChangeEvent = createEvent({
            from: current,
            type: "currentchange",
            navigationType: undefined,
        });

        return this.dispatchEvent(currentChange);
    }

}

function getPerformance(): {
    now(): number;
    measure(name: string, start: string, finish: string): unknown;
    mark(mark: string): unknown;
} {
    if (typeof performance !== "undefined") {
        return performance;
    }
    /* c8 ignore start */
    return {
        now() {
            return Date.now()
        },
        mark() {

        },
        measure() {
        }
    }
    // const { performance: nodePerformance } = await import("perf_hooks");
    // return nodePerformance;
    /* c8 ignore end */
}
