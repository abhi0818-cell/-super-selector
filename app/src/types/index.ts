// ─── Core domain types ────────────────────────────────────────────────────────

export type PlayerRole = 'wk' | 'bat' | 'ar' | 'bowl';
export type MatchFormat = 'T20' | 'ODI' | 'TEST';
export type CaptaincyRole = 'captain' | 'vice_captain' | 'normal';

export interface Player {
  id: string;
  name: string;
  team: string;
  role: PlayerRole;
  credits: number;
  overseas: boolean;
  teamColor: string | null;   // hex color from admin teams table, e.g. '#fbbf24'
  teamColor2: string | null;  // secondary/sleeve hex color from admin teams table (teams.color2)
}

export interface SelectedPlayer extends Player {
  captaincy: CaptaincyRole;
}

// ─── Scoring types ────────────────────────────────────────────────────────────

export interface BattingInnings {
  runs: number;
  ballsFaced: number;
  fours: number;
  sixes: number;
  isDismissed: boolean;
}

export interface BowlingSpell {
  wickets: number;
  wicketTypes: string[];
  maidens: number;
  runsConceded: number;
  ballsBowled: number;
  dotBalls: number;
  noBalls: number;
  wides: number;
}

export interface FieldingStats {
  catches: number;
  stumpings: number;
  runOutDirect: number;
  runOutIndirect: number;
}

export interface PlayerMatchPerf {
  id: string;
  name: string;
  role: PlayerRole;
  captaincy: CaptaincyRole;
  is_overseas?: boolean;   // true = overseas player; used by os_double / indian_double boosters
  batting?: BattingInnings;
  bowling?: BowlingSpell;
  fielding?: FieldingStats;
}

export interface ScoreBreakdown {
  batting?: Record<string, number>;
  bowling?: Record<string, number>;
  fielding?: Record<string, number>;
}

export interface PlayerScore {
  name: string;
  totalPoints: number;
  multiplier: number;
  rawPoints: number;
  breakdown: ScoreBreakdown;
}

// ─── Selection rules ──────────────────────────────────────────────────────────

export interface SelectionRules {
  total: number;
  budget: number;
  role: Record<PlayerRole, [number, number]>;
  maxPerTeam: number;
  maxOverseas: Record<MatchFormat, number>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Contest / League types ───────────────────────────────────────────────────

export type ContestType    = 'daily' | 'sl' | 'private';
export type LeagueRuleType = 'standard' | 'custom';
// 'standard' = same rules/boosters as the main SL contest
// 'custom'   = league has its own rule set (different from SL)

export interface PrivateLeague {
  id:         string;
  name:       string;
  members:    number;
  rank:       number | null;
  ruleType:   LeagueRuleType; // determines whether it nests under SL or stands alone
  deadline:   string;         // ISO string — used to determine "active" league
  isActive:   boolean;        // upcoming match within lock window
}

export interface ContestContext {
  contestId:    string;         // contests.id UUID from Supabase
  contestType:  ContestType;
  leagueId:     string | null;  // null = main contest (no private league)
  leagueName:   string;
  ruleType:     LeagueRuleType;
  deadline:     string;
}

// ─── Navigation types ─────────────────────────────────────────────────────────

// Root stack: Lobby → Main tabs
export type RootStackParamList = {
  TournamentLobby: undefined;
  Main:            undefined;
};

export type RootTabParamList = {
  Home:        undefined;
  MyXI:        { openPicker?: boolean } | undefined;
  Leaderboard: undefined;
  Rules:       undefined;
  Admin:       undefined;
};
