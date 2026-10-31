/**
 * Central game configuration. Every balance value lives here so that rules are
 * documented and tunable in one place (see docs/GAME_RULES.md for the reasoning).
 * Time values are in seconds unless noted; the simulation converts them to ticks.
 */

export type TankClass = 'assault' | 'heavy' | 'scout';
export type TeamId = 1 | 2;
export type PowerUpKind = 'speed' | 'shield' | 'rapid' | 'health' | 'triple' | 'bounce' | 'overcharge';

export type AbilityKind = 'rapid' | 'shield' | 'speed';
export const CLASS_ABILITY: Record<TankClass, AbilityKind> = {
  assault: 'rapid',
  heavy: 'shield',
  scout: 'speed',
};

export const TANK_CLASSES: readonly TankClass[] = ['assault', 'heavy', 'scout'] as const;
export const POWERUP_KINDS: readonly PowerUpKind[] = [
  'speed',
  'shield',
  'rapid',
  'health',
  'triple',
  'bounce',
  'overcharge',
] as const;

export interface ClassConfig {
  label: string;
  health: number;
  /** Forward speed in px/s. */
  speed: number;
  /** Reverse speed multiplier. */
  reverseFactor: number;
  /** Rotation speed in rad/s. */
  turnRate: number;
  /** Seconds between shots. */
  fireCooldown: number;
  /** Damage per bullet. */
  damage: number;
  ability: {
    name: string;
    duration: number;
    cooldown: number;
    /** Rapid Fire: cooldown multiplier. Speed Boost: speed multiplier. */
    multiplier?: number;
    /** Shield: absorbable damage. */
    shieldHp?: number;
  };
}

export const GAME_CONFIG = {
  /** Server simulation rate. */
  tickRate: 30,
  /** Send a snapshot every N ticks (30/2 = 15 snapshots per second). */
  snapshotEvery: 2,

  tileSize: 32,

  match: {
    durationSec: 180,
    overtimeSec: 60,
    countdownSec: 3,
    respawnSec: 3,
    spawnProtectSec: 2,
    friendlyFire: false,
    minPlayers: 2,
    maxPlayers: 8,
    /** Allowed host-configurable range. */
    minDurationSec: 10,
    maxDurationSec: 600,
  },

  tank: {
    radius: 13,
    /** Effects never stack the speed multiplier above this. */
    maxSpeedMultiplier: 2,
    /** Fire cooldown never drops below this many seconds, however effects combine. */
    minFireCooldown: 0.15,
  },

  bullet: {
    speed: 420,
    radius: 3,
    lifetimeSec: 1.4,
    /** Max live bullets per tank. */
    maxPerTank: 4,
    wallDamage: 1,
  },

  walls: {
    destructibleHp: 3,
  },

  classes: {
    assault: {
      label: 'Assault',
      health: 100,
      speed: 150,
      reverseFactor: 0.6,
      turnRate: 3.2,
      fireCooldown: 0.5,
      damage: 20,
      ability: { name: 'Rapid Fire', duration: 3.5, cooldown: 14, multiplier: 0.4 },
    },
    heavy: {
      label: 'Heavy',
      health: 145,
      speed: 105,
      reverseFactor: 0.5,
      turnRate: 2.4,
      fireCooldown: 0.65,
      damage: 20,
      ability: { name: 'Shield', duration: 4, cooldown: 16, shieldHp: 60 },
    },
    scout: {
      label: 'Scout',
      health: 90,
      speed: 195,
      reverseFactor: 0.7,
      turnRate: 4.0,
      fireCooldown: 0.4,
      damage: 18,
      ability: { name: 'Speed Boost', duration: 2.5, cooldown: 11, multiplier: 1.6 },
    },
  } satisfies Record<TankClass, ClassConfig>,

  powerups: {
    spawnIntervalSec: 8,
    maxActive: 4,
    lifetimeSec: 20,
    radius: 11,
    healAmount: 40,
    speedMultiplier: 1.4,
    speedDuration: 5,
    rapidMultiplier: 0.5,
    rapidDuration: 5,
    shieldHp: 40,
    shieldDuration: 6,
    /** Triple Shot: every shot fires three shells in a fan. */
    tripleDuration: 6,
    tripleSpreadRad: 0.17,
    /** Ricochet: shells bounce off steel walls this many times. */
    bounceDuration: 8,
    bounceCount: 2,
    /** Overcharge: shells hit harder. */
    overchargeDuration: 6,
    overchargeMultiplier: 1.5,
  },

  /** Hard anti-cheat ceilings used by the server when validating input. */
  limits: {
    inputsPerSecond: 60,
    /**
     * Lag compensation ceiling: a shooter's bullets are checked against where targets were up to this long ago
     * (what the shooter actually saw). Bounded so a client cannot claim an unlimited rewind.
     */
    maxRewindSec: 0.4,
    maxMessageBytes: 2048,
    maxNameLength: 16,
    reconnectGraceSec: 30,
    lobbyGraceSec: 8,
    roomIdleExpirySec: 600,
    resultsIdleExpirySec: 300,
    maxConnectionsPerIp: 12,
    maxRooms: 200,
  },
} as const;

export type GameConfig = typeof GAME_CONFIG;

export interface MatchSettings {
  durationSec: number;
  overtimeSec: number;
  respawnSec: number;
  spawnProtectSec: number;
  friendlyFire: boolean;
}

export function defaultMatchSettings(): MatchSettings {
  const m = GAME_CONFIG.match;
  return {
    durationSec: m.durationSec,
    overtimeSec: m.overtimeSec,
    respawnSec: m.respawnSec,
    spawnProtectSec: m.spawnProtectSec,
    friendlyFire: m.friendlyFire,
  };
}

export const secondsToTicks = (sec: number, tickRate: number = GAME_CONFIG.tickRate): number =>
  Math.max(1, Math.round(sec * tickRate));
