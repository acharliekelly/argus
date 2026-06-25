import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export type VisualComparison = {
  passed: boolean;
  dimensionsMatch: boolean;
  changedPixels: number;
  changedRatio: number;
  width: number;
  height: number;
  diff: Buffer | null;
};

export function compareImages(
  baselineBuffer: Buffer,
  afterBuffer: Buffer,
  threshold: number
): VisualComparison {
  const baseline = PNG.sync.read(baselineBuffer);
  const after = PNG.sync.read(afterBuffer);
  const dimensionsMatch =
    baseline.width === after.width && baseline.height === after.height;

  if (!dimensionsMatch) {
    const width = Math.max(baseline.width, after.width);
    const height = Math.max(baseline.height, after.height);
    const paddedBaseline = padImage(baseline, width, height);
    const paddedAfter = padImage(after, width, height);
    const diffImage = new PNG({ width, height });
    const changedPixels = pixelmatch(
      paddedBaseline.data,
      paddedAfter.data,
      diffImage.data,
      width,
      height,
      { threshold: 0.1 }
    );
    return {
      passed: false,
      dimensionsMatch: false,
      changedPixels,
      changedRatio: changedPixels / (width * height),
      width,
      height,
      diff: PNG.sync.write(diffImage)
    };
  }

  const diffImage = new PNG({ width: baseline.width, height: baseline.height });
  const changedPixels = pixelmatch(
    baseline.data,
    after.data,
    diffImage.data,
    baseline.width,
    baseline.height,
    { threshold: 0.1 }
  );
  const totalPixels = baseline.width * baseline.height;
  const changedRatio = totalPixels === 0 ? 0 : changedPixels / totalPixels;

  return {
    passed: changedRatio <= threshold,
    dimensionsMatch: true,
    changedPixels,
    changedRatio,
    width: baseline.width,
    height: baseline.height,
    diff: PNG.sync.write(diffImage)
  };
}

function padImage(source: PNG, width: number, height: number): PNG {
  const padded = new PNG({ width, height });
  for (let y = 0; y < source.height; y += 1) {
    const sourceStart = y * source.width * 4;
    const sourceEnd = sourceStart + source.width * 4;
    const targetStart = y * width * 4;
    source.data.copy(padded.data, targetStart, sourceStart, sourceEnd);
  }
  return padded;
}
