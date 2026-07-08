/**
 * ModelViewerPane - 3D model viewer tab
 *
 * Renders mesh and CAD files in a three.js scene with orbit controls:
 *   - STL / OBJ / 3MF / glTF / GLB via three.js loaders
 *   - STEP / IGES / BREP tessellated by the main process (occt-import-js)
 *     over IPC — embind's dynamically generated invokers can't run under
 *     the renderer CSP
 *
 * Everything runs locally. Fusion 360 archives (.f3d/.f3z) are proprietary
 * and cannot be parsed locally, so they get an export-workflow notice.
 *
 * three.js is loaded lazily so it doesn't weigh down startup for sessions
 * that never open a model.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type * as ThreeTypes from 'three';

const lee = (window as any).lee;

const FUSION_EXTENSIONS = ['f3d', 'f3z'];

interface SceneHandles {
  THREE: typeof import('three');
  renderer: ThreeTypes.WebGLRenderer;
  scene: ThreeTypes.Scene;
  camera: ThreeTypes.PerspectiveCamera;
  controls: any;
  root: ThreeTypes.Group;
  grid: ThreeTypes.GridHelper | null;
}

function makeDefaultMaterial(THREE: typeof import('three')): ThreeTypes.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x8899bb,
    metalness: 0.15,
    roughness: 0.6,
    side: THREE.DoubleSide,
  });
}

async function loadModelObject(filePath: string, ext: string): Promise<ThreeTypes.Object3D> {
  const THREE = await import('three');
  const readBytes = async (): Promise<Uint8Array> => {
    const base64: string = await lee.fs.readFileBase64(filePath);
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  };

  switch (ext) {
    case 'stl': {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const geometry = new STLLoader().parse((await readBytes()).buffer as ArrayBuffer);
      if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, makeDefaultMaterial(THREE));
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      return new OBJLoader().parse(new TextDecoder().decode(await readBytes()));
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
      return new ThreeMFLoader().parse((await readBytes()).buffer as ArrayBuffer);
    }
    case 'gltf':
    case 'glb': {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const buffer = (await readBytes()).buffer as ArrayBuffer;
      const gltf = await new Promise<any>((resolve, reject) => {
        new GLTFLoader().parse(buffer, '', resolve, reject);
      });
      return gltf.scene;
    }
    // STEP / IGES / BREP → tessellated by OpenCascade in the main process
    default: {
      const kind = ext === 'iges' || ext === 'igs' ? 'iges' : ext === 'brep' ? 'brep' : 'step';
      const result = await lee.fs.parseCad(filePath, kind);
      if (!result?.success || !result.meshes?.length) {
        throw new Error('OpenCascade could not parse this file — it may be corrupt or an unsupported dialect.');
      }
      const group = new THREE.Group();
      for (const meshData of result.meshes) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(meshData.attributes.position.array, 3)
        );
        if (meshData.attributes.normal) {
          geometry.setAttribute(
            'normal',
            new THREE.Float32BufferAttribute(meshData.attributes.normal.array, 3)
          );
        }
        geometry.setIndex(Array.from(meshData.index.array));
        if (!meshData.attributes.normal) geometry.computeVertexNormals();
        const material = makeDefaultMaterial(THREE);
        if (meshData.color) {
          material.color.setRGB(meshData.color[0], meshData.color[1], meshData.color[2]);
        }
        group.add(new THREE.Mesh(geometry, material));
      }
      return group;
    }
  }
}

function disposeObject(THREE: typeof import('three'), object: ThreeTypes.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((m) => m?.dispose());
    }
  });
}

function countTriangles(THREE: typeof import('three'), object: ThreeTypes.Object3D): number {
  let triangles = 0;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const geometry = child.geometry;
      triangles += Math.floor(
        (geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0) / 3
      );
    }
  });
  return triangles;
}

interface ModelViewerPaneProps {
  active: boolean;
  filePath?: string;
}

export const ModelViewerPane: React.FC<ModelViewerPaneProps> = ({ active, filePath }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandles | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triangles, setTriangles] = useState<number | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  const ext = filePath?.split('.').pop()?.toLowerCase() || '';
  const isFusion = FUSION_EXTENSIONS.includes(ext);

  // Scene lifecycle — created once per pane, torn down on unmount
  useEffect(() => {
    const container = containerRef.current;
    if (!container || isFusion || !filePath) return;
    let disposed = false;
    let rafId = 0;

    (async () => {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      if (disposed || !containerRef.current) return;

      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-primary')
        .trim() || '#15161e';

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(bg);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
      keyLight.position.set(5, 10, 7);
      scene.add(keyLight);

      const camera = new THREE.PerspectiveCamera(
        50,
        (container.clientWidth || 1) / (container.clientHeight || 1),
        0.1,
        10000
      );
      camera.position.set(50, 40, 50);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;

      const root = new THREE.Group();
      scene.add(root);

      sceneRef.current = { THREE, renderer, scene, camera, controls, root, grid: null };
      setSceneReady(true);

      const animate = () => {
        rafId = requestAnimationFrame(animate);
        // display:none containers have zero size — skip rendering while hidden
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        controls.update();
        renderer.render(scene, camera);
      };
      animate();

      const resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      });
      resizeObserver.observe(container);

      const cleanup = () => {
        resizeObserver.disconnect();
        cancelAnimationFrame(rafId);
        controls.dispose();
        disposeObject(THREE, root);
        renderer.dispose();
        renderer.domElement.remove();
        sceneRef.current = null;
      };
      // Stash cleanup so the effect teardown (which may run before async setup
      // finishes) and the post-setup teardown share one path
      (container as any).__modelViewerCleanup = cleanup;
      if (disposed) cleanup();
    })();

    return () => {
      disposed = true;
      const cleanup = (container as any).__modelViewerCleanup;
      if (cleanup) {
        cleanup();
        delete (container as any).__modelViewerCleanup;
      }
      setSceneReady(false);
    };
  }, [filePath, isFusion]);

  // Frame the current model and rescale the ground grid to fit it
  const fitView = useCallback(() => {
    const handles = sceneRef.current;
    if (!handles) return;
    const { THREE, camera, controls, root, scene } = handles;
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    if (handles.grid) {
      scene.remove(handles.grid);
      handles.grid.geometry.dispose();
      (handles.grid.material as ThreeTypes.Material).dispose();
    }
    const grid = new THREE.GridHelper(maxDim * 3, 30, 0x444455, 0x2a2b3a);
    grid.position.set(center.x, box.min.y, center.z);
    scene.add(grid);
    handles.grid = grid;

    camera.near = maxDim / 1000;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    camera.position.set(
      center.x + maxDim * 1.1,
      center.y + maxDim * 0.9,
      center.z + maxDim * 1.1
    );
    controls.target.copy(center);
    controls.update();
  }, []);

  // Load (or reload) the model whenever the scene is up or the file changes
  useEffect(() => {
    if (!sceneReady || !filePath || isFusion || !lee) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const object = await loadModelObject(filePath, ext);
        const handles = sceneRef.current;
        if (!handles) return;
        if (cancelled) {
          disposeObject(handles.THREE, object);
          return;
        }
        handles.root.children.slice().forEach((child) => {
          handles.root.remove(child);
          disposeObject(handles.THREE, child);
        });
        handles.root.add(object);
        setTriangles(countTriangles(handles.THREE, handles.root));
        fitView();
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sceneReady, filePath, ext, isFusion, reloadCount, fitView]);

  // Apply wireframe toggle to every mesh material
  useEffect(() => {
    const handles = sceneRef.current;
    if (!handles) return;
    handles.root.traverse((child) => {
      if (child instanceof handles.THREE.Mesh) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((m: any) => {
          m.wireframe = wireframe;
        });
      }
    });
  }, [wireframe, triangles]);

  const fileName = filePath?.split('/').pop();

  if (isFusion) {
    return (
      <div className={`model-pane ${active ? 'active' : ''}`}>
        <div className="viewer-toolbar">
          <span className="viewer-toolbar-title">🧊 {fileName}</span>
        </div>
        <div className="viewer-body">
          <div className="viewer-message fusion-notice">
            <h3>Fusion 360 archives can't be viewed directly</h3>
            <p>
              <code>.{ext}</code> is a proprietary Autodesk format with no local parser.
              To view this model in Lee, export a neutral format from Fusion 360:
            </p>
            <ul>
              <li><strong>File → Export → STEP (.step)</strong> — full CAD geometry, recommended</li>
              <li><strong>Right-click component → Save As Mesh → STL / 3MF</strong> — mesh only</li>
            </ul>
            <p>Then open the exported file from the file tree.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`model-pane ${active ? 'active' : ''}`}>
      <div className="viewer-toolbar">
        <span className="viewer-toolbar-title">🧊 {fileName ?? '3D Viewer'}</span>
        {triangles !== null && (
          <span className="viewer-toolbar-info">{triangles.toLocaleString()} triangles</span>
        )}
        <div className="viewer-toolbar-actions">
          <button className="viewer-btn" onClick={fitView} title="Frame the model">
            ⤢ Fit
          </button>
          <button
            className={`viewer-btn ${wireframe ? 'active' : ''}`}
            onClick={() => setWireframe((w) => !w)}
            title="Toggle wireframe"
          >
            ◻ Wireframe
          </button>
          <button
            className="viewer-btn"
            onClick={() => setReloadCount((c) => c + 1)}
            title="Reload from disk"
          >
            ↻ Reload
          </button>
        </div>
      </div>
      <div className="viewer-body">
        {!filePath && (
          <div className="viewer-message">
            No file associated with this tab — reopen the file from the file tree.
          </div>
        )}
        {loading && <div className="viewer-message">Loading model…</div>}
        {error && <div className="viewer-message viewer-error">{error}</div>}
        <div className="model-canvas-container" ref={containerRef} />
      </div>
    </div>
  );
};
