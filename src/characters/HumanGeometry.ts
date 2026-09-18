import { DynamicTexture, Mesh, Scene, VertexData } from "@babylonjs/core";

/** Elliptical cross-sections with explicit shoulders/waist/calf contours.
 * Adjacent segments overlap at joints to remain closed during animation. */
export function humanContour(scene: Scene, name: string,
  rings: Array<[number, number, number, number?]>, sides = 20): Mesh {
  const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
  rings.forEach(([y, rx, rz, offset = 0], row) => {
    for (let i = 0; i <= sides; i++) {
      const angle = i / sides * Math.PI * 2;
      positions.push(Math.cos(angle) * rx, y, Math.sin(angle) * rz + offset);
      uvs.push(i / sides, row / (rings.length - 1));
      if (row && i < sides) {
        const a = (row - 1) * (sides + 1) + i, b = a + sides + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  });
  for (const row of [0, rings.length - 1]) {
    const [y, , , z = 0] = rings[row]!;
    const c = positions.length / 3;
    positions.push(0, y, z); uvs.push(0.5, 0.5);
    for (let i = 0; i < sides; i++) {
      const a = row * (sides + 1) + i;
      if (row === 0) indices.push(c, a + 1, a); else indices.push(c, a, a + 1);
    }
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions; data.indices = indices; data.normals = normals; data.uvs = uvs;
  const mesh = new Mesh(name, scene); data.applyToMesh(mesh);
  return mesh;
}

/** Small deterministic woven/camouflage map, shared by a character's clothing. */
export function uniformTexture(scene: Scene, name: string, camouflage: boolean): DynamicTexture {
  const texture = new DynamicTexture(name, 256, scene, true);
  const ctx = texture.getContext();
  ctx.fillStyle = "#b8b6a9"; ctx.fillRect(0, 0, 256, 256);
  let seed = 8517;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  if (camouflage) for (let i = 0; i < 160; i++) {
    ctx.fillStyle = ["#85877c", "#cac5ae", "#a3a58e", "#6e756c"][i % 4]!;
    const x = rand() * 256, y = rand() * 256;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let j = 0; j < 7; j++) {
      const a = j / 7 * Math.PI * 2, r = 3 + rand() * 15;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
  }
  for (let y = 0; y < 256; y += 2) for (let x = 0; x < 256; x += 2) {
    ctx.fillStyle = (x + y) % 4 ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.10)";
    ctx.fillRect(x, y, 1, 2);
  }
  texture.update(false); texture.uScale = 2; texture.vScale = 2;
  return texture;
}
