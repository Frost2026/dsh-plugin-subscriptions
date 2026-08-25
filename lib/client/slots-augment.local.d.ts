declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        /** Mirror of ui-conversation's InputZone currency (see its slots contract). */
        'conversation.input.right': {
            kind: 'list';
            scope: 'session';
            owner: Record<string, unknown>;
        };
    }
}
export {};
