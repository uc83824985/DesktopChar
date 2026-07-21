import type {
  AvatarEvent,
  AvatarSnapshot,
  RuntimeEffect,
  RuntimeTransition,
} from '../../contracts/src/index.ts';

export function createInitialSnapshot(): AvatarSnapshot {
  return {
    state: 'idle',
    generation: 0,
    planId: null,
    segmentId: null,
    sequence: null,
    playback: { status: 'idle', positionMs: 0 },
    speechBubble: {
      phase: 'hidden', presentationId: 0, segmentId: null, displayText: '', positionMs: 0,
    },
    emotion: { current: 'neutral', intensity: 0 },
    gesture: { actionId: null, action: null, queueLength: 0 },
    gaze: { x: 0, y: 0, active: false },
    interrupted: false,
    capabilities: null,
  };
}

function withError(snapshot: AvatarSnapshot, error: AvatarSnapshot['lastError']): AvatarSnapshot {
  if (!error) {
    const { lastError: _, ...withoutError } = snapshot;
    return withoutError;
  }
  return { ...snapshot, lastError: error };
}

function isStale(snapshot: AvatarSnapshot, event: AvatarEvent): boolean {
  return 'generation' in event && event.generation !== snapshot.generation;
}

export function reduceAvatarSnapshot(
  snapshot: AvatarSnapshot,
  event: AvatarEvent,
): RuntimeTransition {
  if (isStale(snapshot, event)) {
    return { snapshot, effects: [] };
  }

  switch (event.type) {
    case 'renderer.ready':
      return {
        snapshot: {
          ...snapshot,
          capabilities: event.capabilities,
          gaze: { ...snapshot.gaze, active: event.capabilities.supportsGaze },
        },
        effects: [],
      };

    case 'renderer.failed':
      return { snapshot: withError(snapshot, event.error), effects: [] };

    case 'plan.submitted': {
      const first = [...event.plan.segments].sort((a, b) => a.sequence - b.sequence)[0];
      const effects: RuntimeEffect[] = event.plan.segments.map(segment => ({
        type: 'tts.synthesize',
        generation: snapshot.generation,
        segment,
      }));
      return {
        snapshot: withError({
          ...snapshot,
          state: 'thinking',
          planId: event.plan.id,
          segmentId: first?.id ?? null,
          sequence: first?.sequence ?? null,
          playback: { status: 'loading', positionMs: 0 },
          interrupted: false,
        }, undefined),
        effects,
      };
    }

    case 'tts.segment-ready':
      return { snapshot, effects: [] };

    case 'tts.segment-failed':
    case 'renderer.motion-failed':
      return { snapshot: withError(snapshot, event.error), effects: [] };

    case 'playback.failed':
      return {
        snapshot: withError({
          ...snapshot,
          state: 'thinking',
          segmentId: null,
          sequence: null,
          playback: { status: 'stopped', positionMs: snapshot.playback.positionMs },
          gesture: { actionId: null, action: null, queueLength: 0 },
        }, event.error),
        effects: [],
      };

    case 'playback.started':
      return {
        snapshot: {
          ...snapshot,
          state: 'speaking',
          segmentId: event.segmentId,
          playback: { status: 'playing', positionMs: event.positionMs },
        },
        effects: [],
      };

    case 'playback.buffering':
      return {
        snapshot: {
          ...snapshot,
          playback: { status: 'buffering', positionMs: event.positionMs },
        },
        effects: [],
      };

    case 'playback.progress':
      return {
        snapshot: {
          ...snapshot,
          playback: { ...snapshot.playback, positionMs: event.positionMs },
        },
        effects: [],
      };

    case 'playback.level':
      return { snapshot, effects: [] };

    case 'playback.stalled':
      return {
        snapshot: {
          ...snapshot,
          playback: { status: 'buffering', positionMs: event.positionMs },
        },
        effects: [],
      };

    case 'playback.recovered':
      return {
        snapshot: {
          ...snapshot,
          playback: { status: 'playing', positionMs: event.positionMs },
        },
        effects: [],
      };

    case 'playback.paused':
      return {
        snapshot: {
          ...snapshot,
          playback: { status: 'paused', positionMs: event.positionMs },
        },
        effects: [],
      };

    case 'playback.resumed':
      return {
        snapshot: {
          ...snapshot,
          playback: { status: 'playing', positionMs: event.positionMs },
        },
        effects: [],
      };

    case 'playback.completed':
      return {
        snapshot: {
          ...snapshot,
          state: 'thinking',
          segmentId: null,
          sequence: null,
          playback: { status: 'idle', positionMs: event.positionMs },
          gesture: { actionId: null, action: null, queueLength: 0 },
        },
        effects: [],
      };

    case 'playback.interrupted':
      return {
        snapshot: {
          ...snapshot,
          state: 'idle',
          playback: { status: 'stopped', positionMs: event.positionMs },
          interrupted: false,
        },
        effects: [],
      };

    case 'user.pause-requested':
      return snapshot.playback.status === 'playing' || snapshot.playback.status === 'buffering'
        ? { snapshot, effects: [{ type: 'audio.pause', generation: snapshot.generation }] }
        : { snapshot, effects: [] };

    case 'user.resume-requested':
      return snapshot.playback.status === 'paused'
        ? { snapshot, effects: [{ type: 'audio.resume', generation: snapshot.generation }] }
        : { snapshot, effects: [] };

    case 'user.look-target-changed':
      return {
        snapshot: {
          ...snapshot,
          gaze: {
            x: Math.max(-1, Math.min(1, event.x)),
            y: Math.max(-1, Math.min(1, event.y)),
            active: snapshot.gaze.active && (snapshot.capabilities?.supportsGaze ?? false),
          },
        },
        effects: [],
      };

    case 'user.gaze-follow-enabled':
      return {
        snapshot: {
          ...snapshot,
          gaze: { ...snapshot.gaze, active: snapshot.capabilities?.supportsGaze ?? false },
        },
        effects: [],
      };

    case 'user.gaze-follow-disabled':
      return {
        snapshot: { ...snapshot, gaze: { ...snapshot.gaze, active: false } },
        effects: [],
      };

    case 'user.interrupt-requested': {
      const oldGeneration = snapshot.generation;
      return {
        snapshot: {
          ...snapshot,
          state: 'idle',
          generation: oldGeneration + 1,
          planId: null,
          segmentId: null,
          sequence: null,
          playback: { status: 'stopped', positionMs: 0 },
          emotion: { current: 'neutral', intensity: 0 },
          gesture: { actionId: null, action: null, queueLength: 0 },
          gaze: snapshot.gaze,
          interrupted: false,
        },
        effects: [
          { type: 'tts.cancel', generation: oldGeneration },
          { type: 'audio.stop', generation: oldGeneration },
        ],
      };
    }

    case 'runtime.segment-selected':
      return {
        snapshot: {
          ...snapshot,
          state: 'thinking',
          segmentId: event.segmentId,
          sequence: event.sequence,
          playback: { status: 'loading', positionMs: 0 },
        },
        effects: [],
      };

    case 'timeline.emotion-cue':
      return {
        snapshot: {
          ...snapshot,
          emotion: {
            current: event.cue.emotion,
            intensity: event.cue.intensity,
          },
        },
        effects: [],
      };

    case 'timeline.action-cue':
      return {
        snapshot: {
          ...snapshot,
          gesture: {
            actionId: event.cue.id,
            action: event.cue.action,
            queueLength: snapshot.gesture.queueLength,
          },
        },
        effects: [{
          type: 'renderer.play-motion',
          generation: snapshot.generation,
          command: {
            actionId: event.cue.id,
            action: event.cue.action,
            priority: event.cue.priority ?? 0,
          },
        }],
      };

    case 'runtime.plan-completed':
      return {
        snapshot: {
          ...snapshot,
          state: 'idle',
          planId: null,
          segmentId: null,
          sequence: null,
          playback: { status: 'idle', positionMs: 0 },
          emotion: { current: 'neutral', intensity: 0 },
          gesture: { actionId: null, action: null, queueLength: 0 },
        },
        effects: [],
      };

    case 'runtime.effect-failed':
      return { snapshot: withError(snapshot, event.error), effects: [] };

    case 'plan.failed':
      return { snapshot: withError(snapshot, event.error), effects: [] };

    case 'renderer.motion-completed':
      return event.actionId === snapshot.gesture.actionId
        ? {
            snapshot: {
              ...snapshot,
              gesture: { actionId: null, action: null, queueLength: snapshot.gesture.queueLength },
            },
            effects: [],
          }
        : { snapshot, effects: [] };

    case 'plan.completed':
    case 'tts.plan-completed':
    case 'plan.segment-appended':
    case 'runtime.speech-bubble-dismissed':
    case 'user.avatar-clicked':
      return { snapshot, effects: [] };
  }
}
