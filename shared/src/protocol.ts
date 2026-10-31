import type { MatchSettings, TankClass, TeamId } from './config';
import type { Difficulty } from './ai';
import type { SimEvent, Snapshot } from './sim';

/** Bumped whenever the wire protocol changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Unambiguous alphabet (no I, L, O, 0, 1). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_REGEX = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export const NAME_REGEX = /^[\p{L}\p{N} _.-]+$/u;

// ---------------------------------------------------------------- client -> server

export type ClientMessage =
  | { t: 'hello'; v: typeof PROTOCOL_VERSION; name: string; resume?: string }
  | { t: 'createRoom'; settings?: { durationSec?: number } }
  | { t: 'joinRoom'; code: string }
  | { t: 'leaveRoom' }
  | { t: 'setTeam'; team: TeamId }
  | { t: 'setClass'; cls: TankClass }
  | { t: 'setSettings'; settings: { durationSec?: number } }
  | { t: 'startMatch' }
  | { t: 'addBot'; team: TeamId; difficulty: Difficulty }
  | { t: 'removeBot'; id: string }
  /** Host: top both teams up with bots (at least 2v2, teams even) - used for "play now with bots". */
  | { t: 'fillBots'; difficulty: Difficulty }
  | { t: 'input'; seq: number; throttle: number; turn: number; fire: boolean; ability: boolean }
  | { t: 'rematch' }
  | { t: 'toLobby' }
  | { t: 'quickMatch' }
  | { t: 'cancelQuick' }
  | { t: 'ping'; ts: number };

export type ClientMessageType = ClientMessage['t'];

// ---------------------------------------------------------------- server -> client

export type ErrorCode =
  | 'bad_message'
  | 'bad_version'
  | 'rate_limited'
  | 'not_ready'
  | 'room_not_found'
  | 'room_expired'
  | 'already_in_room'
  | 'room_full'
  | 'match_in_progress'
  | 'not_host'
  | 'not_in_room'
  | 'bad_state'
  | 'team_full'
  | 'need_players'
  | 'too_many_connections'
  | 'server_busy'
  | 'session_expired'
  | 'internal';

export type RoomPhase = 'lobby' | 'match' | 'results';

export interface PlayerInfo {
  id: string;
  name: string;
  team: TeamId;
  cls: TankClass;
  connected: boolean;
  /** Present for computer-controlled tanks (always labelled as bots in the UI). */
  bot?: Difficulty;
}

export interface RoomInfo {
  code: string;
  hostId: string;
  phase: RoomPhase;
  settings: MatchSettings;
  maxPlayers: number;
  quick: boolean;
  players: PlayerInfo[];
}

export interface BoardEntry {
  id: string;
  name: string;
  team: TeamId;
  cls: TankClass;
  kills: number;
  deaths: number;
  bot?: boolean;
}

export type ServerMessage =
  | { t: 'welcome'; v: number; id: string; token: string; name: string; resumed: boolean }
  | { t: 'room'; room: RoomInfo }
  | { t: 'left' }
  | {
      t: 'matchStart';
      mapId: string;
      tickRate: number;
      snapshotEvery: number;
      you: string;
      snap: Snapshot;
    }
  | { t: 'snap'; s: Snapshot; ev: SimEvent[]; ack: number }
  | { t: 'matchEnd'; winner: 0 | TeamId; scores: [number, number]; board: BoardEntry[]; overtime: boolean }
  | { t: 'queue'; status: 'queued' | 'cancelled'; size: number }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: ErrorCode; message: string };

export type ServerMessageType = ServerMessage['t'];

/** Cheap structural guard used by the client for incoming server messages. */
export function isServerMessage(v: unknown): v is ServerMessage {
  return typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string';
}

export function buildJoinPath(code: string): string {
  return `/join/${encodeURIComponent(code)}`;
}

/** Extract a room code from `/join/CODE` (or a bare code) – returns null when it isn't a valid code. */
export function parseJoinPath(pathOrCode: string): string | null {
  const m = /^\/?(?:join\/)?([A-Za-z0-9]{6})\/?$/.exec(pathOrCode.trim());
  const code = m?.[1]?.toUpperCase();
  return code && ROOM_CODE_REGEX.test(code) ? code : null;
}
