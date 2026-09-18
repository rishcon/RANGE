import {
  Color3, Curve3, DynamicTexture, Mesh, MeshBuilder, Quaternion, Scene,
  StandardMaterial, TransformNode, Vector3,
} from "@babylonjs/core";
import { VIEWMODEL_LAYER, type HandSetup, type ModelFactory } from "./models";

/** Fitted, full-finger gloves for imported firearms. Every part remains under
 * the existing hand animation nodes, including the wrist and forearm. */
export function buildTacticalHands(
  scene: Scene, factory: ModelFactory, hands: HandSetup,
  leftArm: TransformNode, rightArm: TransformNode
): Mesh[] {
  const meshes: Mesh[] = [];
  const leather = factory.material("tactical-leather", new Color3(0.25, 0.265, 0.28), 0.035, 18);
  const padding = factory.material("tactical-padding", new Color3(0.19, 0.2, 0.215), 0.015, 12);
  const seam = factory.material("tactical-stitch", new Color3(0.34, 0.34, 0.32), 0.02, 8);
  const skin = factory.material("tactical-forearm", new Color3(0.58, 0.42, 0.3), 0.018, 12);
  const sleeve = factory.material("tactical-sleeve", new Color3(0.15, 0.16, 0.15), 0.04, 10);
  leather.emissiveColor = new Color3(0.018, 0.018, 0.019);
  padding.emissiveColor = new Color3(0.012, 0.012, 0.013);

  // Fine fabric grain, shared by both gloves; no external image requests.
  if (!leather.diffuseTexture) {
    const grain = new DynamicTexture("vm-glove-grain", 256, scene, true);
    const ctx = grain.getContext();
    ctx.fillStyle = "#a5a5a5";
    ctx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 2) {
      for (let x = 0; x < 256; x += 2) {
        const shade = 145 + ((x * 17 + y * 31 + x * y) % 45);
        ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    grain.update(false);
    leather.diffuseTexture = grain;
    padding.diffuseTexture = grain;
  }

  const add = (mesh: Mesh, parent: TransformNode, mat: StandardMaterial): Mesh => {
    mesh.parent = parent;
    mesh.material = mat;
    mesh.renderingGroupId = VIEWMODEL_LAYER;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.receiveShadows = false;
    mesh.applyFog = false;
    meshes.push(mesh);
    return mesh;
  };
  const oval = (
    name: string, parent: TransformNode, mat: StandardMaterial,
    position: number[], size: number[]
  ): Mesh => {
    const mesh = add(MeshBuilder.CreateSphere(`vm-${name}`, { diameter: 1, segments: 20 }, scene), parent, mat);
    mesh.position.set(position[0]!, position[1]!, position[2]!);
    mesh.scaling.set(size[0]!, size[1]!, size[2]!);
    return mesh;
  };
  const tube = (
    name: string, parent: TransformNode, mat: StandardMaterial,
    points: number[][], radius: number, tip = 0.8
  ): Mesh => {
    const path = Curve3.CreateCatmullRomSpline(points.map(p => new Vector3(p[0], p[1], p[2])), 5).getPoints();
    const mesh = MeshBuilder.CreateTube(`vm-${name}`, {
      path, radius, radiusFunction: i => radius * (1 - (1 - tip) * i / (path.length - 1)),
      tessellation: 12, cap: Mesh.CAP_ALL,
    }, scene);
    return add(mesh, parent, mat);
  };
  const forearm = (name: string, parent: TransformNode, wrist: Vector3, elbow: Vector3): void => {
    const axis = elbow.subtract(wrist);
    const length = axis.length();
    const root = new TransformNode(`vm-${name}-arm-shape`, scene);
    root.parent = parent;
    root.position.copyFrom(wrist);
    root.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), axis.normalize(), new Quaternion());
    // A continuous, tapered forearm with a slight anatomical bulge.
    const path = [0, 0.08, 0.25, 0.55, 0.82, 1].map(t => new Vector3(0, length * t, 0));
    const radii = [0.027, 0.028, 0.034, 0.041, 0.045, 0.043];
    const arm = add(MeshBuilder.CreateTube(`vm-${name}-forearm`, {
      path, radiusFunction: i => radii[i]!, tessellation: 24, cap: Mesh.CAP_ALL,
    }, scene), root, skin);
    arm.scaling.z = 0.86;
    const cuff = add(MeshBuilder.CreateCylinder(`vm-${name}-glove-cuff`, {
      diameterTop: 0.077, diameterBottom: 0.059, height: 0.105, tessellation: 24,
    }, scene), root, leather);
    cuff.position.y = 0.044;
    cuff.scaling.z = 0.88;
    oval(`${name}-cuff-panel`, root, padding, [-0.027, 0.044, -0.018], [0.022, 0.077, 0.044]);
    oval(`${name}-sleeve`, root, sleeve, [0, length + 0.018, 0], [0.102, 0.15, 0.092]);
  };

  if (hands.left) {
    const hand = new TransformNode("vm-left-hand", scene);
    hand.parent = leftArm;
    hand.position.copyFrom(hands.left.pos);
    hand.rotation.copyFrom(hands.left.rot);
    // Support hand cups the underside, with slim fingers around the far side.
    oval("l-palm", hand, leather, [-0.042, -0.036, -0.01], [0.045, 0.075, 0.107]);
    oval("l-back-panel", hand, padding, [-0.062, -0.028, -0.012], [0.014, 0.058, 0.079]);
    oval("l-heel", hand, leather, [-0.038, -0.061, -0.043], [0.055, 0.042, 0.054]);
    for (let i = 0; i < 4; i++) {
      const z = 0.035 - i * 0.023;
      tube(`l-finger-${i}`, hand, leather, [
        [-0.04, -0.018, z], [-0.037, -0.042, z], [-0.012, -0.05, z + 0.003],
        [0.014, -0.043, z + 0.003], [0.032, -0.022, z], [0.032, -0.002, z - 0.002],
      ], 0.009 - i * 0.0004);
      oval(`l-knuckle-${i}`, hand, padding, [-0.057, -0.018, z], [0.021, 0.024, 0.017]);
    }
    tube("l-thumb", hand, leather, [
      [-0.04, -0.055, -0.005], [-0.048, -0.026, 0.034], [-0.032, 0.001, 0.052], [-0.005, 0.007, 0.051],
    ], 0.011);
    tube("l-back-seam", hand, seam, [
      [-0.063, -0.049, -0.044], [-0.067, -0.032, -0.033], [-0.066, -0.01, 0.016], [-0.06, -0.01, 0.028],
    ], 0.0007, 1);
    forearm("left", hand, new Vector3(-0.042, -0.074, -0.052), new Vector3(-0.11, -0.3, -0.14));
  }

  if (hands.right) {
    const hand = new TransformNode("vm-right-hand", scene);
    hand.parent = rightArm;
    hand.position.copyFrom(hands.right.pos);
    hand.rotation.copyFrom(hands.right.rot);
    if (hands.grip === "horizontal") {
      oval("r-palm", hand, leather, [0.031, -0.008, -0.007], [0.043, 0.057, 0.103]);
      oval("r-back-panel", hand, padding, [0.05, -0.008, -0.012], [0.014, 0.045, 0.079]);
      for (let i = 0; i < 4; i++) {
        const z = 0.036 - i * 0.023;
        tube(`r-finger-${i}`, hand, leather, [
          [0.03, -0.009, z], [0.019, -0.026, z], [-0.009, -0.027, z],
          [-0.025, -0.007, z], [-0.019, 0.016, z],
        ], 0.0085 - i * 0.0004);
      }
      tube("r-thumb", hand, leather, [
        [0.029, -0.009, -0.044], [0.026, 0.02, -0.028], [0.003, 0.026, 0.001], [-0.017, 0.019, 0.012],
      ], 0.010);
      forearm("right", hand, new Vector3(0.023, -0.035, -0.047), new Vector3(0.13, -0.38, -0.22));
    } else {
      oval("r-palm", hand, leather, [0.031, -0.002, -0.01], [0.045, 0.095, 0.06]);
      oval("r-back-panel", hand, padding, [0.05, -0.001, -0.013], [0.016, 0.067, 0.044]);
      oval("r-heel", hand, leather, [0.016, -0.037, -0.023], [0.056, 0.049, 0.052]);
      for (let i = 0; i < 3; i++) {
        const y = 0.003 - i * 0.023;
        tube(`r-finger-${i}`, hand, leather, [
          [0.034, y, 0.006], [0.024, y, 0.033], [-0.002, y, 0.039], [-0.024, y, 0.021], [-0.024, y, 0.006],
        ], 0.0095 - i * 0.0006);
      }
      tube("r-trigger-finger", hand, leather, [
        [0.034, 0.032, 0.003], [0.03, 0.045, 0.036], [0.019, 0.044, 0.058], [0.002, 0.029, 0.058],
      ], 0.0085);
      tube("r-thumb", hand, leather, [
        [0.028, 0.025, -0.035], [0.003, 0.045, -0.032], [-0.023, 0.032, -0.014], [-0.025, 0.013, 0.003],
      ], 0.011);
      forearm("right", hand, new Vector3(0.024, -0.058, -0.032), new Vector3(0.11, -0.3, -0.18));
    }
  }
  return meshes;
}
