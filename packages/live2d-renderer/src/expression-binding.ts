export interface RepeatableExpressionManager<Expression = unknown> {
  readonly expressions: ReadonlyArray<Expression | null | undefined>;
  readonly currentExpression: Expression;
  getExpressionIndex(name: string): number;
  restoreExpression(): void;
}

export interface ExpressionActivation {
  applied: boolean;
  mode: 'started' | 'restored' | 'rejected';
}

/**
 * pixi-live2d-display keeps `currentExpression` unchanged when
 * resetExpression() queues the default expression. Calling setExpression()
 * with that same expression afterwards returns false instead of replaying it.
 * Restore the remembered expression explicitly so repeated Runtime emotions
 * behave like fresh activations.
 */
export async function activateRepeatableExpression(
  manager: RepeatableExpressionManager | undefined,
  startExpression: (expressionId: string) => Promise<boolean>,
  expressionId: string,
): Promise<ExpressionActivation> {
  if (manager && isRememberedExpression(manager, expressionId)) {
    manager.restoreExpression();
    return { applied: true, mode: 'restored' };
  }

  const started = await startExpression(expressionId);
  if (started) return { applied: true, mode: 'started' };

  // A concurrent request may have made this expression current while the
  // asynchronous resource load was in flight.
  if (manager && isRememberedExpression(manager, expressionId)) {
    manager.restoreExpression();
    return { applied: true, mode: 'restored' };
  }
  return { applied: false, mode: 'rejected' };
}

function isRememberedExpression(
  manager: RepeatableExpressionManager,
  expressionId: string,
): boolean {
  const requestedIndex = manager.getExpressionIndex(expressionId);
  return requestedIndex >= 0
    && manager.expressions.indexOf(manager.currentExpression) === requestedIndex;
}
