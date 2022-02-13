import { LRUCache } from "./lru-cache.js";
import { VariableGlyph } from "./var-glyph.js";


export class Font {

  constructor(fontDataEngine) {
    this.fontDataEngine = fontDataEngine;
  }

  getReversedCmap() {
    return this.fontDataEngine.getReversedCmap();
  }

  getGlobalAxes() {
    return this.fontDataEngine.getGlobalAxes();
  }

  async getGlyph(glyphName) {
    let glyph = await this.fontDataEngine.getGlyph(glyphName);
    if (glyph) {
      glyph = VariableGlyph.fromObject(glyph, []);  // XXX globalAxes arg!!!
    }
    return glyph;
  }

}
