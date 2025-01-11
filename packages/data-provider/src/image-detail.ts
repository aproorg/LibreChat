export enum ImageDetail {
  low = 'low',
  auto = 'auto',
  high = 'high',
}

export const imageDetailNumeric = {
  [ImageDetail.low]: 0,
  [ImageDetail.auto]: 1,
  [ImageDetail.high]: 2,
} as const;

export const imageDetailValue = {
  0: ImageDetail.low,
  1: ImageDetail.auto,
  2: ImageDetail.high,
} as const;

export const imageDetailSettings = {
  default: ImageDetail.auto,
  min: 0,
  max: 2,
  step: 1,
} as const;
