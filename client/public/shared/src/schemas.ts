import { z } from 'zod';
import { DIFFICULTIES, type Difficulty } from './ai';
import { GAME_CONFIG, TANK_CLASSES, type TankClass } from './config';
import { NAME_REGEX, PROTOCOL_VERSION, ROOM_CODE_REGEX, type ClientMessage } from './protocol';

const name = z
  .string()
  .trim()
  .min(1)
  .max(GAME_CONFIG.limits.maxNameLength)
  .regex(NAME_REGEX, 'name contains unsupported characters');

const roomCode = z
  .string()
  .max(16)
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(ROOM_CODE_REGEX, 'invalid room code'));

const teamId = z.union([z.literal(1), z.literal(2)]);
const tankClass = z.enum(TANK_CLASSES as unknown as [TankClass, ...TankClass[]]);
const difficulty = z.enum(DIFFICULTIES as unknown as [Difficulty, ...Difficulty[]]);

const settingsPatch = z.strictObject({
  durationSec: z
    .number()
    .int()
    .min(GAME_CONFIG.match.minDurationSec)
    .max(GAME_CONFIG.match.maxDurationSec)
    .optional(),
});

// ---------------------------------------------------------------- client -> server

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('hello'),
    v: z.literal(PROTOCOL_VERSION),
    name,
    /** Session token from a previous `welcome`, used to resume after a dropped connection. */
    resume: z.string().min(16).max(64).optional(),
  }),
  z.strictObject({
    t: z.literal('createRoom'),
    settings: settingsPatch.optional(),
    open: z.boolean().optional(),
  }),
  z.strictObject({ t: z.literal('joinRoom'), code: roomCode }),
  z.strictObject({ t: z.literal('leaveRoom') }),
  z.strictObject({ t: z.literal('setTeam'), team: teamId }),
  z.strictObject({ t: z.literal('setClass'), cls: tankClass }),
  z.strictObject({ t: z.literal('setSettings'), settings: settingsPatch }),
  z.strictObject({ t: z.literal('startMatch') }),
  z.strictObject({ t: z.literal('addBot'), team: teamId, difficulty }),
  z.strictObject({ t: z.literal('removeBot'), id: z.string().regex(/^bot-[0-9]{1,4}$/) }),
  z.strictObject({ t: z.literal('fillBots'), difficulty }),
  z.strictObject({
    t: z.literal('input'),
    seq: z.number().int().min(0).max(2_000_000_000),
    throttle: z.number().min(-1).max(1),
    turn: z.number().min(-1).max(1),
    fire: z.boolean(),
    ability: z.boolean(),
    vt: z.number().int().min(0).max(2_000_000_000).optional(),
  }),
  z.strictObject({ t: z.literal('rematch') }),
  z.strictObject({ t: z.literal('toLobby') }),
  z.strictObject({ t: z.literal('quickMatch') }),
  z.strictObject({ t: z.literal('cancelQuick') }),
  z.strictObject({ t: z.literal('ping'), ts: z.number().min(0).max(1e15) }),
]);

// Compile-time guarantee that what the schema accepts is assignable to the documented ClientMessage type.
const _assertSchemaMatchesType = (m: z.infer<typeof ClientMessageSchema>): ClientMessage => m;
void _assertSchemaMatchesType;
