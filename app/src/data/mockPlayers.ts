import { Player } from '../types';

// Same 30-player IPL mock pool as index.html
// teamColor is null here — real colors come from the teams table via Supabase.
export const MOCK_PLAYERS: Player[] = [
  { id: 'p01', name: 'MS Dhoni',           team: 'CSK', role: 'wk',   credits:  9.0, overseas: false, teamColor: null },
  { id: 'p02', name: 'Rishabh Pant',       team: 'DC',  role: 'wk',   credits:  9.5, overseas: false, teamColor: null },
  { id: 'p03', name: 'KL Rahul',           team: 'SRH', role: 'wk',   credits: 10.0, overseas: false, teamColor: null },
  { id: 'p04', name: 'Sanju Samson',       team: 'RR',  role: 'wk',   credits:  9.5, overseas: false, teamColor: null },
  { id: 'p05', name: 'Rohit Sharma',       team: 'MI',  role: 'bat',  credits: 10.5, overseas: false, teamColor: null },
  { id: 'p06', name: 'Virat Kohli',        team: 'RCB', role: 'bat',  credits: 11.0, overseas: false, teamColor: null },
  { id: 'p07', name: 'Shubman Gill',       team: 'GT',  role: 'bat',  credits: 10.0, overseas: false, teamColor: null },
  { id: 'p08', name: 'Faf du Plessis',     team: 'RCB', role: 'bat',  credits:  9.0, overseas: true,  teamColor: null },
  { id: 'p09', name: 'David Warner',       team: 'DC',  role: 'bat',  credits:  9.5, overseas: true,  teamColor: null },
  { id: 'p10', name: 'Suryakumar Yadav',   team: 'MI',  role: 'bat',  credits: 10.0, overseas: false, teamColor: null },
  { id: 'p11', name: 'Ruturaj Gaikwad',    team: 'CSK', role: 'bat',  credits:  9.0, overseas: false, teamColor: null },
  { id: 'p12', name: 'Yashasvi Jaiswal',   team: 'RR',  role: 'bat',  credits:  9.5, overseas: false, teamColor: null },
  { id: 'p13', name: 'Hardik Pandya',      team: 'GT',  role: 'ar',   credits: 10.5, overseas: false, teamColor: null },
  { id: 'p14', name: 'Ravindra Jadeja',    team: 'CSK', role: 'ar',   credits:  9.5, overseas: false, teamColor: null },
  { id: 'p15', name: 'Andre Russell',      team: 'KKR', role: 'ar',   credits: 10.0, overseas: true,  teamColor: null },
  { id: 'p16', name: 'Sunil Narine',       team: 'KKR', role: 'ar',   credits:  9.0, overseas: true,  teamColor: null },
  { id: 'p17', name: 'Glenn Maxwell',      team: 'RCB', role: 'ar',   credits:  9.5, overseas: true,  teamColor: null },
  { id: 'p18', name: 'Axar Patel',         team: 'DC',  role: 'ar',   credits:  8.5, overseas: false, teamColor: null },
  { id: 'p19', name: 'Marcus Stoinis',     team: 'SRH', role: 'ar',   credits:  8.5, overseas: true,  teamColor: null },
  { id: 'p20', name: 'Jasprit Bumrah',     team: 'MI',  role: 'bowl', credits: 10.5, overseas: false, teamColor: null },
  { id: 'p21', name: 'Mohammed Shami',     team: 'GT',  role: 'bowl', credits:  9.5, overseas: false, teamColor: null },
  { id: 'p22', name: 'Yuzvendra Chahal',   team: 'RR',  role: 'bowl', credits:  9.0, overseas: false, teamColor: null },
  { id: 'p23', name: 'Rashid Khan',        team: 'GT',  role: 'bowl', credits: 10.0, overseas: true,  teamColor: null },
  { id: 'p24', name: 'Kuldeep Yadav',      team: 'DC',  role: 'bowl', credits:  9.0, overseas: false, teamColor: null },
  { id: 'p25', name: 'Mohammed Siraj',     team: 'RCB', role: 'bowl', credits:  9.0, overseas: false, teamColor: null },
  { id: 'p26', name: 'T Natarajan',        team: 'SRH', role: 'bowl', credits:  8.5, overseas: false, teamColor: null },
  { id: 'p27', name: 'Deepak Chahar',      team: 'CSK', role: 'bowl', credits:  8.5, overseas: false, teamColor: null },
  { id: 'p28', name: 'Trent Boult',        team: 'RR',  role: 'bowl', credits:  9.5, overseas: true,  teamColor: null },
  { id: 'p29', name: 'Varun Chakravarthy', team: 'KKR', role: 'bowl', credits:  8.5, overseas: false, teamColor: null },
  { id: 'p30', name: 'Arshdeep Singh',     team: 'SRH', role: 'bowl', credits:  8.5, overseas: false, teamColor: null },
];

export const TEAMS = ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'DC', 'RR', 'GT'] as const;
