const twgl = require('twgl.js');

const Rectangle = require('./Rectangle');
const TextBubbleSkin = require('./TextBubbleSkin');

const __point = twgl.v3.create();
const __fenceBounds = new Rectangle();

const methods = {
    /**
     * @param {int} drawableID the drawable that is asking
     * @param {Array<int>} [candidateIDs] candidateIDs
     * @returns {?Array<number>} a a
     */
    getTouchingDrawablesPoint (drawableID, candidateIDs = this._drawList) {
        const drawable = this._allDrawables[drawableID];
        if (!drawable || !drawable._visible) return null;
        const candidates = this._candidatesTouching(drawableID,
            candidateIDs.filter(id => this._allDrawables[id] && this._allDrawables[id]._visible));
        if (candidates.length === 0) return null;

        const bounds = this._candidatesBounds(candidates);
        drawable.updateCPURenderAttributes();
        const point = __point;
        for (let x = bounds.left; x <= bounds.right; x++) {
            point[0] = x;
            for (let y = bounds.bottom; y <= bounds.top; y++) {
                point[1] = y;
                if (drawable.isTouching(point)) {
                    for (let index = 0; index < candidates.length; index++) {
                        if (candidates[index].drawable.isTouching(point)) {
                            return [x, y];
                        }
                    }
                }
            }
        }
        return null;
    },

    /**
     * @param {int} drawableID the drawable
     * @returns {?{left: number, right: number, top: number, bottom: number}} its fence bounds
     */
    ctPmFenceBounds (drawableID) {
        const drawable = this._allDrawables[drawableID];
        if (!drawable || !drawable.skin) return null;
        const r = drawable.skin.getFenceBounds(drawable, __fenceBounds);
        return {left: r.left, right: r.right, top: r.top, bottom: r.bottom};
    },

    /**
     * @param {int} skinID a text bubble skin
     * @param {?object} style style
     */
    ctPmSetTextBubbleStyle (skinID, style) {
        const skin = this._allSkins[skinID];
        if (!(skin instanceof TextBubbleSkin)) return;
        if (!skin._ctPmDefaultStyle) skin._ctPmDefaultStyle = skin._style;
        const next = Object.assign({}, skin._ctPmDefaultStyle, style || {});
        const key = JSON.stringify(next);
        if (skin._ctPmStyleKey === key) return;
        skin._ctPmStyleKey = key;
        skin.setStyle(next);
    }
};

/**
 * @param {Function} RenderWebGL RenderWebGL
 */
const install = RenderWebGL => {
    for (const name of Object.keys(methods)) {
        RenderWebGL.prototype[name] = methods[name];
    }
};

module.exports = install;
