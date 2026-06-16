// Matches the CSS variables in index.html exactly

export const colors = {
  bg:       '#F5F0E0',
  bgGrad:   '#EDE8D5',
  panel:    '#FFFFFF',
  panel2:   '#EDE8D5',
  border:   '#D6CFA8',
  muted:    '#7A7060',
  text:     '#1C1F26',
  accent:   '#C9A84C',
  accent2:  '#EDD98A',
  good:     '#2D6A35',
  bad:      '#C0392B',

  // Role tag backgrounds / text
  roleBat:    { bg: '#DDE3F0', text: '#1A2744' },
  roleBowl:   { bg: '#EDE7F6', text: '#4527A0' },
  roleAr:     { bg: '#FFF3CD', text: '#92650A' },
  roleWk:     { bg: '#FBE9E7', text: '#BF360C' },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm:   6,
  md:   8,
  lg:   10,
  xl:   12,
  full: 9999,
} as const;

export const fontSize = {
  xs:   9,
  sm:   11,
  md:   13,
  base: 14,
  lg:   16,
  xl:   18,
  xxl:  24,
  '3xl': 28,
} as const;

export const shadow = {
  card: {
    shadowColor: '#C9A84C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
} as const;
