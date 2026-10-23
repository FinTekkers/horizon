// HZ-557: the check that a masked element really is covered in the shot.
// worker.mjs masks with Playwright's own `mask` option, then runs leakedBox()
// on the decoded PNG before anything is written to disk.

export const MASK_COLOR = '#FF00FF'
export const MASK_RGB = [0xff, 0x00, 0xff]

// The index of the first box ({x, y, width, height} in PNG pixels) holding
// any pixel that is not `rgb`, or -1. Each box is clipped to the PNG, and a
// fractional edge is rounded inward, so an anti-aliased border never reads as
// a leak. A box wholly outside the PNG (below a maxHeightPx cut) is not one.
export function leakedBox(png, boxes, rgb = MASK_RGB) {
  for (let b = 0; b < boxes.length; b++) {
    const box = boxes[b]
    const x0 = Math.max(0, Math.ceil(box.x))
    const y0 = Math.max(0, Math.ceil(box.y))
    const x1 = Math.min(png.width, Math.floor(box.x + box.width))
    const y1 = Math.min(png.height, Math.floor(box.y + box.height))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (png.width * y + x) * 4
        if (png.data[i] !== rgb[0] || png.data[i + 1] !== rgb[1] || png.data[i + 2] !== rgb[2]) return b
      }
    }
  }
  return -1
}
