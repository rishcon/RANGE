import { Color3, LoadAssetContainerAsync, Matrix, Mesh, PBRMaterial, Scene, StandardMaterial, TransformNode, Vector3, type AssetContainer } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import classicM4Url from "../../classic_m4.glb?url";
import { VIEWMODEL_LAYER, VM_SCALE, type WeaponModel } from "./models";

/** Vite includes the original GLB in both the web and Electron builds. */
export function loadClassicM4(scene: Scene): Promise<AssetContainer> {
  return LoadAssetContainerAsync(classicM4Url, scene, { pluginExtension: ".glb" });
}

export function buildClassicM4(scene: Scene, root: TransformNode, asset: AssetContainer): WeaponModel {
  const body = new TransformNode("vm-m4-body", scene);
  body.parent = root;
  body.position.z = 0.34;
  body.scaling.setAll(VM_SCALE);

  const meshes = asset.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
  const magazine = meshes.find(mesh => mesh.name === "Magazine_m4_0");
  const bolt = meshes.find(mesh => mesh.name === "BoltCarrier_m4_0");
  const chargingHandle = meshes.find(mesh => mesh.name === "ChargingHandle_m4_0");
  if (!magazine || !bolt || !chargingHandle) throw new Error("В classic_m4.glb отсутствуют подвижные детали M4");

  asset.addAllToScene();
  // The loader has already converted the FBX export hierarchy to Babylon's
  // left-handed coordinates (+Z forward). Bake that hierarchy once so all
  // moving parts use the same metre-based axes as the procedural animations.
  const fit = Matrix.Scaling(1.35, 1.35, 1.35).multiply(Matrix.Translation(0.00153, 0.041, 0.193));
  const transforms = meshes.map(mesh => mesh.computeWorldMatrix(true).multiply(fit));
  const glassMeshes: Mesh[] = [];
  meshes.forEach((mesh, index) => {
    // glTF caches accessor bounds; recompute them after changing vertices,
    // otherwise frustum culling and detached-magazine pivots use the old axes.
    if (mesh.geometry) mesh.geometry.useBoundingInfoFromGeometry = false;
    mesh.bakeTransformIntoVertices(transforms[index]!);
    mesh.parent = body;
    mesh.position.setAll(0);
    mesh.rotationQuaternion = null;
    mesh.rotation.setAll(0);
    mesh.scaling.setAll(1);
    if (mesh.name === "Scope_scope_0") glassMeshes.push(makeOpticTransparent(mesh, scene));
    // A detached magazine must spin about itself, not about the rifle's origin.
    const center = mesh.getBoundingInfo().boundingBox.center.clone();
    mesh.bakeTransformIntoVertices(Matrix.Translation(-center.x, -center.y, -center.z));
    mesh.position.copyFrom(center);
    mesh.refreshBoundingInfo();
    mesh.name = `vm-m4-${mesh.name}`;
    mesh.renderingGroupId = VIEWMODEL_LAYER;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.receiveShadows = false;
    mesh.applyFog = false;
    if (mesh.material instanceof PBRMaterial && mesh.material.albedoTexture) {
      // A small texture-coloured fill keeps the metal readable under the
      // range canopy, where the procedural world has no environment map.
      mesh.material.emissiveTexture = mesh.material.albedoTexture;
      mesh.material.emissiveColor.set(0.16, 0.16, 0.16);
    }
  });
  meshes.push(...glassMeshes);
  // The geometry now lives under body; remove the empty import hierarchy.
  for (const mesh of asset.meshes) {
    if (!mesh.parent && !meshes.includes(mesh as Mesh)) mesh.dispose();
  }

  const point = (name: string, x: number, y: number, z: number): TransformNode => {
    const node = new TransformNode(`vm-m4-${name}`, scene);
    node.parent = body;
    node.position.set(x, y, z);
    return node;
  };
  const pose = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => ({
    pos: new Vector3(x, y, z), rot: new Vector3(rx, ry, rz),
  });

  return {
    body,
    meshes,
    magazine,
    bolt,
    chargingHandle,
    muzzle: point("muzzle", 0, 0.0409, 0.663),
    ejectPort: point("eject", 0.037, 0.046, 0.215),
    hideOnAds: false,
    // Позу задаёт рига рук: у неё свои клипы на покой, ходьбу, бег и
    // перезарядку, поэтому смещать ствол вручную больше незачем. Остаётся
    // только глубина выноса при прицеливании — всё остальное решается по марке.
    poses: {
      hip: pose(0, 0, 0),
      // В прицеле ствол уходит от лица вперёд: иначе предплечья лезут в кадр.
      ads: pose(0, 0, 0.24),
      sprint: pose(0, 0, 0),
      reload: pose(0, 0, 0),
    },
    // Центр апертуры коллиматора, измерен по геометрии GLB.
    sight: new Vector3(0.0008, 0.1283, 0.2412),
    hands: {
      rig: true,
      style: "tactical",
      right: pose(0.004, -0.074, 0.123, -0.22, 0, 0),
      rightForearm: null,
      left: pose(0, 0.025, 0.385, 0, 0, 0),
      leftForearm: null,
    },
  };
}

/** The source optic contains four opaque optical inserts in one material.
 * Give those planar surfaces glass while retaining the textured metal tube. */
function makeOpticTransparent(scope: Mesh, scene: Scene): Mesh {
  const vertices = scope.getVerticesData("position")!;
  const indices = scope.getIndices()!;
  const opticalPlanes = [-0.003162, 0.01575, 0.042227, 0.066614];
  const glassIndices: number[] = [];
  const solidIndices: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    const optical = opticalPlanes.some(z => triangle.every(vertex => {
      // Back to source metres for the measured optical-plane coordinates.
      const x = (vertices[vertex * 3]! - 0.00153) / 1.35;
      const y = (vertices[vertex * 3 + 1]! - 0.041) / 1.35;
      const depth = (vertices[vertex * 3 + 2]! - 0.193) / 1.35;
      return Math.abs(depth - z) < 0.0004 && Math.hypot(x + 0.0011, y - 0.06465) < 0.018;
    }));
    (optical ? glassIndices : solidIndices).push(...triangle);
  }
  if (glassIndices.length === 0) throw new Error("Не найдены линзы прицела Classic M4");
  const glass = scope.clone("vm-m4-optic-glass", scope.parent);
  glass.makeGeometryUnique();
  glass.setIndices(glassIndices);
  scope.setIndices(solidIndices);
  const material = new StandardMaterial("vm-m4-optic-glass", scene);
  material.diffuseColor = new Color3(0.12, 0.18, 0.2);
  material.specularColor = Color3.Black();
  material.alpha = 0.06;
  material.backFaceCulling = false;
  glass.material = material;
  glass.renderingGroupId = VIEWMODEL_LAYER;
  glass.isPickable = false;
  glass.checkCollisions = false;
  glass.receiveShadows = false;
  glass.applyFog = false;
  glass.refreshBoundingInfo();
  return glass;
}
