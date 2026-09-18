import {
  LoadAssetContainerAsync, Matrix, Mesh, PBRMaterial, Scene, TransformNode, Vector3, type AssetContainer,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import g18Url from "../../g18_pistol.glb?url";
import { VIEWMODEL_LAYER, VM_SCALE, type WeaponModel } from "./models";

export function loadG18(scene: Scene): Promise<AssetContainer> {
  return LoadAssetContainerAsync(g18Url, scene, { pluginExtension: ".glb" });
}

/** Reassemble the supplied display model and expose its moving parts to the
 * existing firearm animations. Loose cartridges are presentation props. */
export function buildG18(scene: Scene, root: TransformNode, asset: AssetContainer): WeaponModel {
  const source = asset.meshes.find(mesh => mesh.name === "copyright ban 18_0");
  if (!(source instanceof Mesh)) throw new Error("В g18_pistol.glb не найден корпус G18");
  const body = new TransformNode("vm-g18-body", scene);
  body.parent = root;
  body.position.z = 0.3;
  body.scaling.setAll(VM_SCALE);
  asset.addAllToScene();

  const world = source.computeWorldMatrix(true).clone();
  const positions = source.getVerticesData("position")!;
  const indices = source.getIndices()!;
  const points: Vector3[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    points.push(Vector3.TransformCoordinates(Vector3.FromArray(positions, i), world));
  }
  const parts = { frame: [] as number[], slide: [] as number[], magazine: [] as number[] };
  for (const component of connectedComponents(points, indices)) {
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const index of component) { min.minimizeInPlace(points[index]!); max.maximizeInPlace(points[index]!); }
    // A small accessory is displayed beside the gun, not mounted on it.
    if (min.x > 0.08) continue;
    const magazine = max.y < -0.1;
    const slide = min.y > 0.033 || (min.y > 0.02 && max.z - min.z > 0.2 && max.y - min.y > 0.03);
    parts[magazine ? "magazine" : slide ? "slide" : "frame"].push(...component);
  }

  const meshes: Mesh[] = [];
  for (const kind of ["frame", "slide", "magazine"] as const) {
    if (parts[kind].length === 0) throw new Error(`В G18 не найдена деталь: ${kind}`);
    const mesh = source.clone(`vm-g18-${kind}`, body);
    mesh.makeGeometryUnique();
    mesh.geometry!.useBoundingInfoFromGeometry = false;
    mesh.setIndices(parts[kind]);
    // The source points backwards. Turn it forward; the magazine is exported
    // 15 cm below its seated position. Keep the original texture coordinates.
    const transform = world
      .multiply(Matrix.Translation(0, kind === "magazine" ? 0.15 : 0, 0))
      .multiply(Matrix.RotationY(Math.PI))
      .multiply(Matrix.Translation(0, -0.014, 0.045));
    mesh.bakeTransformIntoVertices(transform);
    // Remove unused vertices: bounds and the falling-magazine pivot must
    // describe this part, rather than the original combined presentation mesh.
    compactVertices(mesh);
    const center = mesh.getBoundingInfo().boundingBox.center.clone();
    mesh.bakeTransformIntoVertices(Matrix.Translation(-center.x, -center.y, -center.z));
    mesh.parent = body;
    mesh.position.copyFrom(center);
    mesh.rotationQuaternion = null;
    mesh.rotation.setAll(0);
    mesh.scaling.setAll(1);
    mesh.renderingGroupId = VIEWMODEL_LAYER;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.receiveShadows = false;
    mesh.applyFog = false;
    mesh.refreshBoundingInfo();
    if (mesh.material instanceof PBRMaterial && mesh.material.albedoTexture) {
      mesh.material.emissiveTexture = mesh.material.albedoTexture;
      mesh.material.emissiveColor.set(0.16, 0.16, 0.16);
    }
    meshes.push(mesh);
  }
  // Dispose only the original presentation hierarchy, retaining the material
  // and textures now shared by the assembled pistol.
  for (const mesh of [...asset.meshes]) if (!mesh.parent) mesh.dispose();

  const point = (name: string, x: number, y: number, z: number) => {
    const node = new TransformNode(`vm-g18-${name}`, scene);
    node.parent = body;
    node.position.set(x, y, z);
    return node;
  };
  const pose = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => ({
    pos: new Vector3(x, y, z), rot: new Vector3(rx, ry, rz),
  });
  return {
    body, meshes, magazine: meshes[2]!, bolt: meshes[1]!, hideOnAds: false,
    muzzle: point("muzzle", 0, 0.0305, 0.164),
    ejectPort: point("eject", 0.02, 0.034, 0.019),
    // Место в кадре задаёт рига рук, поэтому от позы остаётся только то, что
    // меняется относительно неё: вынос вперёд в прицеле и отклонения на бег и
    // перезарядку.
    poses: {
      hip: pose(0, 0, 0),
      ads: pose(0, 0, 0.12),
      sprint: pose(0.02, -0.065, 0.02, 0.09, 0.4, 0.2),
      reload: pose(-0.05, 0.005, 0, -0.05, -0.36, -0.24),
    },
    // Целик на задней кромке затвора — по нему прицеливание выводит оружие в
    // центр кадра.
    sight: new Vector3(0, 0.051, -0.055),
    hipTarget: new Vector3(0.03, -0.09, 0.46),
    hands: {
      rig: true,
      style: "tactical",
      right: pose(0, -0.044, -0.034, -0.16), rightForearm: null,
      left: pose(-0.005, -0.022, -0.016), leftForearm: null,
    },
  };
}

/** Weld UV seams only for connectivity analysis; retain all original UVs and
 * normals in the actual geometry so textured parts separate cleanly. */
function connectedComponents(points: Vector3[], indices: ArrayLike<number>): number[][] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  const positions = new Map<string, number>();
  points.forEach((point, i) => {
    const key = point.asArray().map(value => value.toFixed(6)).join(",");
    const existing = positions.get(key);
    if (existing !== undefined) parent[find(i)] = find(existing);
    else positions.set(key, i);
  });
  for (let i = 0; i < indices.length; i += 3) {
    parent[find(indices[i + 1]!)] = find(indices[i]!);
    parent[find(indices[i + 2]!)] = find(indices[i]!);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < indices.length; i += 3) {
    const root = find(indices[i]!);
    let group = groups.get(root);
    if (!group) { group = []; groups.set(root, group); }
    group.push(indices[i]!, indices[i + 1]!, indices[i + 2]!);
  }
  return [...groups.values()];
}

function compactVertices(mesh: Mesh): void {
  const indices = mesh.getIndices()!;
  const used = [...new Set(indices)];
  const remap = new Map(used.map((index, i) => [index, i]));
  for (const kind of mesh.getVerticesDataKinds()) {
    const buffer = mesh.getVertexBuffer(kind)!;
    const size = buffer.getSize();
    const data = mesh.getVerticesData(kind)!;
    const compact = new Float32Array(used.length * size);
    used.forEach((index, i) => {
      for (let j = 0; j < size; j++) compact[i * size + j] = data[index * size + j]!;
    });
    mesh.setVerticesData(kind, compact, false, size);
  }
  mesh.setIndices(Array.from(indices, index => remap.get(index)!));
  mesh.refreshBoundingInfo();
}
