import type { AvatarEvent, AvatarSnapshot } from '../../contracts/src/index.ts';

export interface RuntimeTransport {
  dispatch(event: AvatarEvent): void;
  subscribe(listener: (snapshot: AvatarSnapshot) => void): () => void;
}
