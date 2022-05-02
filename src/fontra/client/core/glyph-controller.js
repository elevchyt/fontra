import { Transform } from "./transform.js";
import {
  VariationModel,
  locationToString,
  mapForward,
  mapBackward,
  normalizeLocation,
  piecewiseLinearMap,
} from "./var-model.js";
import VarPath from "./var-path.js";


export class VariableGlyphController {

  constructor(glyph, globalAxes) {
    this.glyph = glyph;
    this.globalAxes = globalAxes;
    this._locationToSourceIndex = {};
  }

  get name() {
    return this.glyph.name;
  }

  get axes() {
    return this.glyph.axes;
  }

  get sources() {
    return this.glyph.sources;
  }

  getLayerGlyph(layerName) {
    return this.glyph.getLayerGlyph(layerName);
  }

  getLayerIndex(layerName) {
    return this.glyph.getLayerIndex(layerName);
  }

  getSourceIndex(location) {
    const locationStr = locationToString(location);
    if (!(locationStr in this._locationToSourceIndex)) {
      this._locationToSourceIndex[locationStr] = this._getSourceIndex(location);
    }
    return this._locationToSourceIndex[locationStr];
  }

  _getSourceIndex(location) {
    location = mapForward(location, this.globalAxes);
    location = mapBackward(location, this.getLocalToGlobalMapping());
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      let found = true;
      for (const [axisName, triple] of Object.entries(this.axisDictLocal)) {
        const baseName = getAxisBaseName(axisName);
        let varValue = location[baseName];
        let sourceValue = source.location[axisName];
        if (varValue === undefined) {
          varValue = triple[1];
        }
        if (sourceValue === undefined) {
          sourceValue = triple[1];
        }
        if (varValue !== sourceValue) {
          found = false;
          break;
        }
      }
      if (found) {
        return i;
      }
    }
    return undefined;
  }

  getAllComponentNames() {
    // Return a set of all component names used by all layers of all sources
    const componentNames = new Set();
    for (const layer of this.glyph.layers) {
      for (const component of layer.glyph.components) {
        componentNames.add(component.name);
      }
    }
    return componentNames;
  }

  getLocalToGlobalMapping() {
    const pseudoAxisList = [];
    for (const [axisName, localTriple] of Object.entries(this.axisDictLocal)) {
      const globalTriple = this.axisDictGlobal[axisName];
      const mapping = [];
      for (let i = 0; i < 3; i++) {
        mapping.push([localTriple[i], globalTriple[i]]);
      }
      pseudoAxisList.push({"name": axisName, "mapping": mapping});
    }
    return pseudoAxisList;
  }

  clearDeltasCache() {
    delete this._deltas;
  }

  clearModelCache() {
    delete this._model;
    delete this._deltas;
    delete this._axisDictGlobal;
    delete this._axisDictLocal;
    this._locationToSourceIndex = {};
  }

  get model() {
    if (this._model === undefined) {
      const locations = this.sources.map(source => source.location);
      this._model = new VariationModel(
        locations.map(location => normalizeLocationSparse(location, this.axisDictLocal)),
        this.axes.map(axis => axis.name));
    }
    return this._model;
  }

  get deltas() {
    if (this._deltas === undefined) {
      const masterValues = this.sources.map(source => this.getLayerGlyph(source.layerName));
      this._deltas = this.model.getDeltas(masterValues);
    }
    return this._deltas;
  }

  get axisDictGlobal() {
    if (this._axisDictGlobal === undefined) {
      this._axisDictGlobal = this._combineGlobalAndLocalAxes(false);
    }
    return this._axisDictGlobal;
  }

  get axisDictLocal() {
    if (this._axisDictLocal === undefined) {
      this._axisDictLocal = this._combineGlobalAndLocalAxes(true);
    }
    return this._axisDictLocal;
  }

  _combineGlobalAndLocalAxes(prioritizeLocal) {
    const usedAxisNames = new Set(
      this.sources.reduce((prev, cur) => prev.concat(Object.keys(cur.location)), [])
    );
    const axisDict = {};
    for (const axis of this.globalAxes) {
      if (usedAxisNames.has(axis.name)) {
        const m = makeAxisMapFunc(axis);
        axisDict[axis.name] = [axis.minValue, axis.defaultValue, axis.maxValue].map(m);
      }
    }
    for (const axis of this.axes) {
      if (prioritizeLocal || !(axis.name in axisDict)) {
        axisDict[axis.name] = [axis.minValue, axis.defaultValue, axis.maxValue];
      }
    }
    return axisDict;
  }

  instantiate(location, fromGlobal = true) {
    const axisDict = fromGlobal ? this.axisDictGlobal : this.axisDictLocal;
    try {
      return this.model.interpolateFromDeltas(
        normalizeLocation(location, axisDict), this.deltas
      );
    } catch (error) {
      if (error.name !== "VariationError") {
        throw error;
      }
      const errorMessage = `Interpolation error while instantiating glyph ${this.name} (${error.toString()})`;
      const indexInfo = findClosestSourceIndexFromLocation(
        this.glyph, normalizeLocation(location, axisDict), this.axisDictLocal
      );
      return this.getLayerGlyph(this.sources[indexInfo.index].layerName);
    }
  }

  async instantiateController(location, getGlyphFunc) {
    const sourceIndex = this.getSourceIndex(location);
    location = mapForward(mapNLILocation(location, this.axes), this.globalAxes);
    let instance;
    if (sourceIndex !== undefined) {
      instance = this.getLayerGlyph(this.sources[sourceIndex].layerName);
    } else {
      instance = this.instantiate(location);
    }

    if (!instance) {
      throw new Error("assert -- instance is undefined")
    }
    const instanceController = new StaticGlyphController(
      this.name, instance, sourceIndex,
    );

    // Map the axis values for which local axes exist to the
    // local axes, while leaving the other global axis values alone.
    let localLocation = subsetLocation(location, this.axes)
    localLocation = mapForward(localLocation, this.globalAxes);
    localLocation = mapBackward(localLocation, this.getLocalToGlobalMapping());
    location = {...location, ...localLocation};

    await instanceController.setupComponents(getGlyphFunc, location);
    return instanceController;
  }

}


class StaticGlyphController {

  constructor(name, instance, sourceIndex) {
    this.name = name;
    this.instance = instance;
    this.sourceIndex = sourceIndex;
    this.canEdit = sourceIndex !== undefined;
  }

  async setupComponents(getGlyphFunc, parentLocation) {
    this.components = [];
    for (const compo of this.instance.components) {
      const compoController = new ComponentController(compo);
      await compoController.setupPath(getGlyphFunc, parentLocation);
      this.components.push(compoController);
    }
  }

  clearCache() {
    delete this._flattenedPath;
    delete this._flattenedPath2d;
    delete this._path2d;
    delete this._componentsPath;
    delete this._componentsPath2d;
    delete this._controlBounds;
    delete this._convexHull;
  }

  get xAdvance() {
    return this.instance.xAdvance;
  }

  get yAdvance() {
    return this.instance.yAdvance;
  }

  get verticalOrigin() {
    return this.instance.verticalOrigin;
  }

  get flattenedPath() {
    if (this._flattenedPath === undefined) {
      this._flattenedPath = joinPaths([this.instance.path, this.componentsPath]);
    }
    return this._flattenedPath;
  }

  get flattenedPath2d() {
    if (this._flattenedPath2d === undefined) {
      this._flattenedPath2d = new Path2D();
      this.flattenedPath.drawToPath2d(this._flattenedPath2d);
    }
    return this._flattenedPath2d;
  }

  get path() {
    return this.instance.path;
  }

  get path2d() {
    if (this._path2d === undefined) {
      this._path2d = new Path2D();
      this.instance.path.drawToPath2d(this._path2d);
    }
    return this._path2d;
  }

  get componentsPath() {
    if (this._componentsPath === undefined) {
      this._componentsPath = joinPaths(this.components.map(compo => compo.path));
    }
    return this._componentsPath;
  }

  get componentsPath2d() {
    if (this._componentsPath2d === undefined) {
      this._componentsPath2d = new Path2D();
      this.componentsPath?.drawToPath2d(this._componentsPath2d);
    }
    return this._componentsPath2d;
  }

  get controlBounds() {
    if (this._controlBounds === undefined) {
      this._controlBounds = this.flattenedPath.getControlBounds();
    }
    return this._controlBounds;
  }

  get convexHull() {
    if (this._convexHull === undefined) {
      this._convexHull = this.flattenedPath.getConvexHull();
    }
    return this._convexHull;
  }

}


class ComponentController {

  constructor(compo) {
    this.compo = compo;
  }

  async setupPath(getGlyphFunc, parentLocation) {
    this.path = await getComponentPath(this.compo, getGlyphFunc, parentLocation);
  }

  get path2d() {
    if (this._path2d === undefined) {
      this._path2d = new Path2D();
      this.path.drawToPath2d(this._path2d);
    }
    return this._path2d;
  }

  get controlBounds() {
    if (this._controlBounds === undefined) {
      this._controlBounds = this.path.getControlBounds();
    }
    return this._controlBounds;
  }

  get convexHull() {
    if (this._convexHull === undefined) {
      this._convexHull = this.path.getConvexHull();
    }
    return this._convexHull;
  }

}


async function getComponentPath(compo, getGlyphFunc, parentLocation) {
  return flattenComponentPaths(
    await getNestedComponentPaths(compo, getGlyphFunc, parentLocation)
  );
}


async function getNestedComponentPaths(compo, getGlyphFunc, parentLocation, transformation = null) {
  const compoLocation = mergeLocations(parentLocation, compo.location);
  const glyph = await getGlyphFunc(compo.name);
  if (!glyph) {
    return {};
  }
  let inst;
  try {
    inst = glyph.instantiate(compoLocation || {}, false);
  } catch (error) {
    if (error.name !== "VariationError") {
      throw error;
    }
    const errorMessage = `Interpolation error while instantiating component ${compo.name} (${error.toString()})`;
    console.log(errorMessage);
    return {"error": errorMessage};
  }
  let t = makeAffineTransform(compo.transformation);
  if (transformation) {
    t = transformation.transform(t);
  }
  const componentPaths = {};
  if (inst.path.numPoints) {
    componentPaths["path"] = inst.path.transformed(t);
  }
  componentPaths["children"] = await getComponentPaths(inst.components, getGlyphFunc, compoLocation, t);
  return componentPaths;
}


async function getComponentPaths(components, getGlyphFunc, parentLocation, transformation = null) {
  const paths = [];

  for (const compo of components || []) {
    paths.push(await getNestedComponentPaths(compo, getGlyphFunc, parentLocation, transformation));
  }
  return paths;
}


function flattenComponentPaths(item) {
  const paths = [];
  if (item.path !== undefined) {
    paths.push(item.path);
  }
  if (item.children !== undefined) {
    for (const child of item.children) {
      const childPath = flattenComponentPaths(child);
      if (!!childPath) {
        paths.push(childPath);
      }
    }
  }
  return joinPaths(paths);
}


function makeAxisMapFunc(axis) {
  if (!axis.mapping) {
    return v => v;
  }
  const mapping = Object.fromEntries(axis.mapping);
  return v => piecewiseLinearMap(v, mapping);
}


function normalizeLocationSparse(location, axes) {
  const normLoc = normalizeLocation(location, axes);
  for (const [name, value] of Object.entries(normLoc)) {
    if (!value) {
      delete normLoc[name];
    }
  }
  return normLoc;
}


export function getAxisBaseName(axisName) {
  return axisName.split("*", 1)[0];
}


function mapNLILocation(userLocation, axes) {
  const nliAxes = {};
  for (const axis of axes) {
    const baseName = axis.name.split("*", 1)[0];
    if (baseName !== axis.name) {
      if (!(baseName in nliAxes)) {
        nliAxes[baseName] = [];
      }
      nliAxes[baseName].push(axis.name);
    }
  }
  const location = {};
  for (const [baseName, value] of Object.entries(userLocation)) {
    for (const realName of nliAxes[baseName] || [baseName]) {
      location[realName] = value;
    }
  }
  return location;
}


function joinPaths(paths) {
  if (paths.length) {
    return paths.reduce((p1, p2) => p1.concat(p2));
  }
  return new VarPath();
}


function mergeLocations(loc1, loc2) {
  if (!loc1) {
    return loc2;
  }
  return {...loc1, ...loc2};
}


function makeAffineTransform(transformation) {
  let t = new Transform();
  t = t.translate(transformation.x + transformation.tcenterx, transformation.y + transformation.tcentery);
  t = t.rotate(transformation.rotation * (Math.PI / 180));
  t = t.scale(transformation.scalex, transformation.scaley);
  t = t.translate(-transformation.tcenterx, -transformation.tcentery);
  return t;
}


function subsetLocation(location, axes) {
  const subsettedLocation = {};
  for (const axis of axes) {
    if (axis.name in location) {
      subsettedLocation[axis.name] = location[axis.name]
    }
  }
  return subsettedLocation;
}


function findClosestSourceIndexFromLocation(glyph, location, axisDict) {
  const distances = [];
  for (let i = 0; i < glyph.sources.length; i++) {
    const sourceLocation = normalizeLocation(glyph.sources[i].location, axisDict);
    let distanceSquared = 0;
    for (const [axisName, value] of Object.entries(location)) {
      const sourceValue = sourceLocation[axisName];
      distanceSquared += (sourceValue - value) ** 2;
    }
    distances.push([distanceSquared, i]);
    if (distanceSquared === 0) {
      // exact match, no need to look further
      break;
    }
  }
  distances.sort((a, b) => {
    const da = a[0];
    const db = b[0];
    return (a > b) - (a < b);
  });
  return {distance: Math.sqrt(distances[0][0]), index: distances[0][1]}
}
