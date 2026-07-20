import type { SceneScenario, SceneScenarioTrigger } from './types.ts';

export interface SceneScenarioSelection {
  scenarios: readonly SceneScenario[];
  event: string;
  nowMs: number;
  lastActivatedAt: Readonly<Record<string, number>>;
  randomValue: number;
}

export function selectSceneScenario(input: SceneScenarioSelection): SceneScenario | undefined {
  if (!Number.isFinite(input.nowMs)) throw new Error('Scenario clock must be finite');
  if (!Number.isFinite(input.randomValue) || input.randomValue < 0 || input.randomValue >= 1) {
    throw new Error('Scenario randomValue must be in [0, 1)');
  }

  const candidates: Array<{ scenario: SceneScenario; trigger: SceneScenarioTrigger }> = [];
  const scenarioIds = new Set<string>();
  for (const scenario of input.scenarios) {
    if (scenario.id.trim().length === 0) throw new Error('Scenario id must not be empty');
    if (scenarioIds.has(scenario.id)) throw new Error(`Duplicate scenario id "${scenario.id}"`);
    scenarioIds.add(scenario.id);
    const lastActivatedAt = input.lastActivatedAt[scenario.id];
    if (lastActivatedAt !== undefined && !Number.isFinite(lastActivatedAt)) {
      throw new Error(`Scenario "${scenario.id}" activation time must be finite`);
    }
    for (const trigger of scenario.triggers) validateTrigger(scenario.id, trigger);
    const matching = scenario.triggers
      .filter(trigger => trigger.event === input.event)
      .filter(trigger => input.nowMs - (input.lastActivatedAt[scenario.id] ?? Number.NEGATIVE_INFINITY) >= trigger.cooldownMs)
      .sort((left, right) => right.priority - left.priority)[0];
    if (matching) candidates.push({ scenario, trigger: matching });
  }
  if (candidates.length === 0) return undefined;

  const priority = Math.max(...candidates.map(candidate => candidate.trigger.priority));
  const eligible = candidates.filter(candidate => candidate.trigger.priority === priority);
  const totalWeight = eligible.reduce((sum, candidate) => sum + candidate.trigger.weight, 0);
  let cursor = input.randomValue * totalWeight;
  for (const candidate of eligible) {
    cursor -= candidate.trigger.weight;
    if (cursor < 0) return candidate.scenario;
  }
  return eligible.at(-1)?.scenario;
}

function validateTrigger(scenarioId: string, trigger: SceneScenarioTrigger): void {
  if (trigger.event.trim().length === 0) throw new Error(`Scenario "${scenarioId}" trigger event must not be empty`);
  if (!Number.isFinite(trigger.priority)) throw new Error(`Scenario "${scenarioId}" trigger priority must be finite`);
  if (!Number.isFinite(trigger.weight) || trigger.weight <= 0) {
    throw new Error(`Scenario "${scenarioId}" trigger weight must be positive`);
  }
  if (!Number.isFinite(trigger.cooldownMs) || trigger.cooldownMs < 0) {
    throw new Error(`Scenario "${scenarioId}" trigger cooldown must be non-negative`);
  }
}
