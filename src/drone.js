// Drone flight. WASD along the view's heading, Space up, C down, Shift fast. It eases in and out of
// speed, slides along walls, flies over low furniture, and fits through holes and stairwells but
// not through floors or ceilings. Allocation free; d = { y, v: Float64Array(3) }.
import { collide, cramped } from './gen.js';
import { levelOf, levelSeed, groundAt, ceilAt, collideProps, FH } from './levels.js';

export const DRONE_R = 0.2, DRONE_H = 0.12, DRONE_SPEED = 3, DRONE_FAST = 7.5;   // radius, half height, m/s

// f, s, u: forward, right, up in -1..1
export function flyDrone(seed, pos, d, f, s, u, fast, yaw, dt) {
  const sp = fast ? DRONE_FAST : DRONE_SPEED, n = Math.hypot(f, s) || 1, sy = Math.sin(yaw), cy = Math.cos(yaw), v = d.v;
  const tx = (sy * f + cy * s) / n * sp, tz = (-cy * f + sy * s) / n * sp, ty = u * sp * 0.7;
  const a = 1 - Math.exp(-dt * 3.5);
  v[0] += (tx - v[0]) * a; v[1] += (ty - v[1]) * a; v[2] += (tz - v[2]) * a;
  // across: walls and furniture of the level the drone is in, at its height
  const lv = levelOf(d.y), base = lv * FH, ox = pos[0], oz = pos[1];
  pos[0] += v[0] * dt; pos[1] += v[2] * dt;
  collide(levelSeed(seed, lv), pos, DRONE_R, d.y - base + DRONE_H, d.y - base - DRONE_H);
  collideProps(seed, lv, pos, DRONE_R, d.y - base - DRONE_H);
  if (d.y - DRONE_H < groundAt(seed, lv, pos[0], pos[1]) || d.y + DRONE_H > ceilAt(seed, lv, pos[0], pos[1])) {
    pos[0] = ox; pos[1] = oz; v[0] *= 0.3; v[2] *= 0.3;   // the edge of a hole or a stair tread: bump
  }
  // up and down, between whatever floor and ceiling are above and below it here
  const oy = d.y;
  d.y += v[1] * dt;
  // rising in a doorway or window would put it inside the wall over it (or sinking, into a sill)
  const l1 = levelOf(d.y);
  if (cramped(levelSeed(seed, l1), pos, DRONE_R - 0.02, d.y - l1 * FH + DRONE_H, d.y - l1 * FH - DRONE_H)) { d.y = oy; v[1] = 0; }
  const l2 = levelOf(d.y), lo = groundAt(seed, l2, pos[0], pos[1]) + DRONE_H + 0.03, hi = ceilAt(seed, l2, pos[0], pos[1]) - DRONE_H - 0.03;
  if (d.y < lo) { d.y = lo; v[1] = 0; }
  if (d.y > hi) { d.y = hi; v[1] = 0; }
}
