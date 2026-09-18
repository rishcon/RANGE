import { LoadAssetContainerAsync, Matrix, Mesh, PBRMaterial, Scene, TransformNode, Vector3, type AssetContainer } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import sniperUrl from "../../sniper.glb?url";
import knifeUrl from "../../m9_bayonet_knife.glb?url";
import { VIEWMODEL_LAYER, VM_SCALE, type WeaponModel } from "./models";

export const loadSniper = (scene: Scene): Promise<AssetContainer> =>
  LoadAssetContainerAsync(sniperUrl, scene, { pluginExtension: ".glb" });
export const loadBayonet = (scene: Scene): Promise<AssetContainer> =>
  LoadAssetContainerAsync(knifeUrl, scene, { pluginExtension: ".glb" });

function assemble(scene: Scene, root: TransformNode, asset: AssetContainer, name: string, fit: Matrix) {
  const body = new TransformNode(`vm-${name}-body`, scene);
  body.parent = root;
  body.position.z = name === "sniper" ? 0.34 : 0.27;
  body.scaling.setAll(VM_SCALE);
  asset.addAllToScene();
  const meshes = asset.meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
  const transforms = meshes.map(m => m.computeWorldMatrix(true).multiply(fit));
  meshes.forEach((mesh, i) => {
    mesh.geometry!.useBoundingInfoFromGeometry = false;
    mesh.bakeTransformIntoVertices(transforms[i]!);
    const center = mesh.getBoundingInfo().boundingBox.center.clone();
    mesh.bakeTransformIntoVertices(Matrix.Translation(-center.x, -center.y, -center.z));
    mesh.parent = body;
    mesh.position.copyFrom(center);
    mesh.rotationQuaternion = null;
    mesh.rotation.setAll(0);
    mesh.scaling.setAll(1);
    mesh.name = `vm-${name}-${mesh.name}`;
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
  });
  for (const mesh of [...asset.meshes]) if (!mesh.parent) mesh.dispose();
  const point = (label: string, x: number, y: number, z: number) => {
    const node = new TransformNode(`vm-${name}-${label}`, scene);
    node.parent = body; node.position.set(x, y, z); return node;
  };
  return { body, meshes, point };
}

const pose = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => ({
  pos: new Vector3(x, y, z), rot: new Vector3(rx, ry, rz),
});

export function buildImportedSniper(scene: Scene, root: TransformNode, asset: AssetContainer): WeaponModel {
  // The Babylon import faces +Z; the FBX was authored in centimetre-like units.
  const { body, meshes, point } = assemble(scene, root, asset, "sniper",
    Matrix.Scaling(0.007, 0.007, 0.007).multiply(Matrix.Translation(0, -0.045, -0.04)));
  const magazine = meshes.find(m => m.name.endsWith("mag_sniper_0"))!;
  const bolt = meshes.find(m => m.name.endsWith("bolt_sniper_0"))!;
  const boltBack = meshes.find(m => m.name.endsWith("boltback_sniper_0"))!;
  const bullet = meshes.find(m => m.name.endsWith("bullet_sniper_0"))!;
  if (!magazine || !bolt || !boltBack || !bullet) throw new Error("В sniper.glb отсутствуют подвижные детали");
  // Rotate about the bore axis, not the bounding-box centre of the handle.
  const boltPivot = new Vector3(0, 11.119815826416016 * 0.007 - 0.045,
    (5.566669464111328 + 6.17671537399292) * 0.007 - 0.04);
  const offset = bolt.position.subtract(boltPivot);
  bolt.bakeTransformIntoVertices(Matrix.Translation(offset.x, offset.y, offset.z));
  bolt.position.copyFrom(boltPivot);
  boltBack.setParent(bolt);
  // Merge the visible cartridge into the magazine so dropping/replacing the
  // magazine never leaves a floating round behind.
  const merged = Mesh.MergeMeshes([magazine, bullet], true, true)!;
  merged.name = "vm-sniper-magazine";
  merged.bakeTransformIntoVertices(Matrix.Invert(body.computeWorldMatrix(true)));
  const magCenter = merged.getBoundingInfo().boundingBox.center.clone();
  merged.bakeTransformIntoVertices(Matrix.Translation(-magCenter.x, -magCenter.y, -magCenter.z));
  merged.parent = body;
  merged.position.copyFrom(magCenter);
  merged.renderingGroupId = VIEWMODEL_LAYER;
  merged.isPickable = false;
  merged.applyFog = false;
  meshes.splice(meshes.indexOf(magazine), 1);
  meshes.splice(meshes.indexOf(bullet), 1);
  meshes.push(merged);
  return {
    body, meshes, magazine: merged, bolt, hideOnAds: true,
    manualBolt: {
      handle: new Vector3(6.246137 * 0.007, 4.916242 * 0.007 - 0.045, 7.260256 * 0.007 - 0.04).subtract(boltPivot),
      travel: 0.075, liftAngle: 1.05,
    },
    muzzle: point("muzzle", 0, 0.033, 0.856), ejectPort: point("eject", 0.033, 0.033, 0.07),
    // Позу задаёт рига рук; от позы остаётся только вынос вперёд в прицеле.
    poses: {
      hip: pose(0, 0, 0), ads: pose(0, 0, 0.2),
      sprint: pose(0, 0, 0), reload: pose(0, 0, 0),
    },
    sight: new Vector3(0, 0.0873, 0.24),
    hands: {
      rig: true,
      style: "tactical", right: pose(0, -0.063, -0.009, -0.3), rightForearm: null,
      left: pose(0, -0.005, 0.23), leftForearm: null,
    },
  };
}

export function buildBayonet(scene: Scene, root: TransformNode, asset: AssetContainer): WeaponModel {
  const { body, meshes, point } = assemble(scene, root, asset, "m9", Matrix.Scaling(0.012, 0.012, 0.012));
  return {
    body, meshes, magazine: null, bolt: null, hideOnAds: false,
    muzzle: point("tip", 0, 0, 0.279), ejectPort: point("eject", 0, 0, 0),
    // Позы пересчитаны относительно хвата риги: место в кадре задаёт она, а
    // здесь остаются только отклонения от него.
    poses: {
      hip: pose(0, 0, 0),
      ads: pose(0, 0.1, 0, -0.48, -0.37, 0.25),
      sprint: pose(0.01, -0.06, 0, 0.22, 0.85, 0.1),
      reload: pose(0, 0, 0),
    },
    hipTarget: new Vector3(0.05, -0.1, 0.46),
    hands: {
      rig: true,
      style: "tactical", grip: "horizontal", right: pose(0, 0, -0.026), rightForearm: null,
      left: null, leftForearm: null,
    },
  };
}
