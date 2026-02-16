export enum LevelType {
  TRAINING = 'training',
  CAPTURE = 'capture',
  RACE = 'race',
  SURVIVAL = 'survival'
}

export interface Level {
  id: number;
  name: string;
  type: LevelType;
  description: string;
  layout: 'open' | 'corridor' | 'maze' | 'arena';
  objective: string;
  targetCount: number;
  enemyCount: number;
  timeLimit: number | null;
  requiredScore: number;
}

export const LEVELS: Level[] = [
  {
    id: 1,
    name: 'Training: Basics',
    type: LevelType.TRAINING,
    description: 'Learn basic movement and controls',
    layout: 'open',
    objective: 'Destroy 5 targets',
    targetCount: 5,
    enemyCount: 0,
    timeLimit: null,
    requiredScore: 500
  },
  {
    id: 2,
    name: 'Training: Wall Runs',
    type: LevelType.TRAINING,
    description: 'Practice wall running and wall jumps',
    layout: 'corridor',
    objective: 'Destroy 8 targets using wall runs',
    targetCount: 8,
    enemyCount: 0,
    timeLimit: 120,
    requiredScore: 800
  },
  {
    id: 3,
    name: 'Training: Sliding',
    type: LevelType.TRAINING,
    description: 'Master sliding and mantle techniques',
    layout: 'maze',
    objective: 'Complete the slide course',
    targetCount: 3,
    enemyCount: 0,
    timeLimit: 90,
    requiredScore: 600
  },
  {
    id: 4,
    name: 'Capture: Outpost Alpha',
    type: LevelType.CAPTURE,
    description: 'Hold capture points to secure the area',
    layout: 'arena',
    objective: 'Hold capture points for 30 seconds',
    targetCount: 0,
    enemyCount: 4,
    timeLimit: 180,
    requiredScore: 1000
  },
  {
    id: 5,
    name: 'Race: Speed Course',
    type: LevelType.RACE,
    description: 'Complete the course as fast as possible',
    layout: 'corridor',
    objective: 'Reach the finish line',
    targetCount: 0,
    enemyCount: 2,
    timeLimit: 60,
    requiredScore: 1200
  },
  {
    id: 6,
    name: 'Survival: Last Stand',
    type: LevelType.SURVIVAL,
    description: 'Survive against waves of enemies',
    layout: 'open',
    objective: 'Survive for 60 seconds',
    targetCount: 0,
    enemyCount: 6,
    timeLimit: 60,
    requiredScore: 1500
  }
];
