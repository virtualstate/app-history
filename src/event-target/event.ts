export interface Event<Name extends string | symbol = string | symbol> {
    type: Name
    parallel?: boolean
    signal?: {
        aborted: boolean
    }
    [key: string]: unknown
    [key: number]: unknown
}

export function isEvent(value: unknown): value is Event {
    function isLike(value: unknown): value is { type: unknown } {
        return !!value;
    }
    return isLike(value) && (
        typeof value.type === "string" ||
        typeof value.type === "symbol"
    )
}

export function assertEvent<T extends string | symbol, E extends Event<T>>(value: unknown, type?: T): asserts value is E {
    if (!isEvent(value)) {
        throw new Error("Expected event");
    }
    if (typeof type !== "undefined" && value.type !== type) {
        throw new Error(`Expected event type ${type}, got ${value.type.toString()}`);
    }
}