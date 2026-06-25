import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { compareImages } from '../src/browser/visual.js';

function png(width: number, height: number, color: [number, number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = color[0];
    image.data[index + 1] = color[1];
    image.data[index + 2] = color[2];
    image.data[index + 3] = color[3];
  }
  return PNG.sync.write(image);
}

describe('compareImages', () => {
  it('passes identical images', () => {
    const image = png(2, 2, [255, 255, 255, 255]);
    const result = compareImages(image, image, 0);

    expect(result).toMatchObject({
      passed: true,
      changedPixels: 0,
      changedRatio: 0,
      dimensionsMatch: true
    });
  });

  it('fails images with different dimensions', () => {
    const result = compareImages(
      png(2, 2, [255, 255, 255, 255]),
      png(3, 2, [255, 255, 255, 255]),
      1
    );

    expect(result.passed).toBe(false);
    expect(result.dimensionsMatch).toBe(false);
    expect(result.diff).toBeInstanceOf(Buffer);
  });

  it('fails when changed-pixel ratio exceeds threshold', () => {
    const result = compareImages(
      png(2, 2, [255, 255, 255, 255]),
      png(2, 2, [0, 0, 0, 255]),
      0.5
    );

    expect(result.passed).toBe(false);
    expect(result.changedRatio).toBe(1);
    expect(result.diff).toBeInstanceOf(Buffer);
  });
});
