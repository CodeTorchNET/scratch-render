const FENCE_WIDTH = 15;

/**
 * Non-finite values.
 * @param {*} x value
 * @param {number} fallback fallback
 * @returns {number} x or fallback
 */
const finite = (x, fallback) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

class CameraView {
    constructor (name) {
        this.name = name;
        this.x = 0;
        this.y = 0;
        this.dir = 0;
        this.scale = 1;
        this.a = 1;
        this.b = 0;
        this.active = false;
        this.drawables = new Set();
        this._sweepAt = 64;
    }

    set (state) {
        this.x = finite(state && state.x, 0);
        this.y = finite(state && state.y, 0);
        this.dir = finite(state && state.dir, 0);
        this.scale = finite(state && state.scale, 1);
        const radians = this.dir * Math.PI / 180;
        this.a = this.scale * Math.cos(radians);
        this.b = this.scale * Math.sin(radians);
        this.active = !(this.x === 0 && this.y === 0 && this.dir === 0 && this.scale === 1);
    }
}

/**
 * Premultiply a drawable's model matrix.
 * @param {Drawable} drawable the drawable, with an active `_ctPmCamera`
 * @param {Float32Array} m m
 */
const applyView = (drawable, m) => {
    const view = drawable._ctPmCamera;
    const a = view.a;
    const b = view.b;
    const m0 = m[0];
    const m1 = m[1];
    const m4 = m[4];
    const m5 = m[5];
    m[0] = (a * m0) - (b * m1);
    m[1] = (b * m0) + (a * m1);
    m[4] = (a * m4) - (b * m5);
    m[5] = (b * m4) + (a * m5);

    const px = drawable._position[0] - view.x;
    const py = drawable._position[1] - view.y;
    let sx = (a * px) - (b * py);
    let sy = (b * px) + (a * py);
    if (!drawable._highQuality) {
        sx = Math.round(sx);
        sy = Math.round(sy);
    }
    const ox = m[12] - drawable._position[0];
    const oy = m[13] - drawable._position[1];
    m[12] = (a * ox) - (b * oy) + sx;
    m[13] = (b * ox) + (a * oy) + sy;
};

/**
 * The drawable's scale as seen on screen, for choosing texture resolution.
 * @param {Drawable} drawable the drawable, with an active `_ctPmCamera`
 * @returns {Array<number>} [x, y] scale in percent
 */
const viewScale = drawable => {
    const zoom = Math.abs(drawable._ctPmCamera.scale);
    return [drawable._scale[0] * zoom, drawable._scale[1] * zoom];
};

/**
 * @param {Drawable} drawable a drawable
 * @returns {boolean} true true
 */
const rotated = drawable => !!drawable._ctPmCamera && drawable._ctPmCamera.dir % 90 !== 0;

/**
 * RenderWebGL#getFencedPositionOfDrawable for a drawable on a camera.
 * @param {RenderWebGL} renderer the renderer
 * @param {Drawable} drawable the drawable, with an active `_ctPmCamera`
 * @param {Array<number>} position requested world position
 * @param {Rectangle} fenceBounds scratch rectangle
 * @returns {Array<number>} fenced world position
 */
const fencedPosition = (renderer, drawable, position, fenceBounds) => {
    const view = drawable._ctPmCamera;
    const toScreen = (x, y) => {
        const dx = x - view.x;
        const dy = y - view.y;
        return [(view.a * dx) - (view.b * dy), (view.b * dx) + (view.a * dy)];
    };
    const target = toScreen(position[0], position[1]);
    const current = toScreen(drawable._position[0], drawable._position[1]);
    let x = target[0];
    let y = target[1];
    const dx = x - current[0];
    const dy = y - current[1];
    const aabb = drawable._skin.getFenceBounds(drawable, fenceBounds);
    const inset = Math.floor(Math.min(aabb.width, aabb.height) / 2);
    const sx = renderer._xRight - Math.min(FENCE_WIDTH, inset);
    if (aabb.right + dx < -sx) {
        x = Math.ceil(current[0] - (sx + aabb.right));
    } else if (aabb.left + dx > sx) {
        x = Math.floor(current[0] + (sx - aabb.left));
    }
    const sy = renderer._yTop - Math.min(FENCE_WIDTH, inset);
    if (aabb.top + dy < -sy) {
        y = Math.ceil(current[1] - (sy + aabb.top));
    } else if (aabb.bottom + dy > sy) {
        y = Math.floor(current[1] + (sy - aabb.bottom));
    }
    if (x === target[0] && y === target[1]) return [position[0], position[1]];
    const det = (view.a * view.a) + (view.b * view.b);
    if (det === 0) return [position[0], position[1]];
    return [
        view.x + (((view.a * x) + (view.b * y)) / det),
        view.y + (((view.a * y) - (view.b * x)) / det)
    ];
};

/**
 * Point a drawable at the camera object it should use.
 * @param {RenderWebGL} renderer the renderer
 * @param {Drawable} drawable the drawable
 * @param {?CameraView} view its camera
 * @param {boolean} [force] force
 */
const attach = (renderer, drawable, view, force) => {
    const next = view && view.active ? view : null;
    if (drawable._ctPmCamera === next && !(force && next)) {
        return;
    }
    drawable._ctPmCamera = next;
    drawable.setTransformDirty();
    renderer.dirty = true;
};

const methods = {
    /**
     * @param {string} name camera name
     * @param {boolean} create make it if it doesn't exist
     * @returns {?CameraView} the camera
     * @private
     */
    _ctPmCamera (name, create) {
        if (!this._ctPmCameras) {
            if (!create) return null;
            this._ctPmCameras = new Map();
        }
        let view = this._ctPmCameras.get(name);
        if (!view && create) {
            view = new CameraView(name);
            this._ctPmCameras.set(name, view);
        }
        return view || null;
    },

    /**
     * Set a camera.
     * @param {string} name camera name
     * @param {?{x: number, y: number, dir: number, scale: number}} state state
     */
    ctPmSetCamera (name, state) {
        name = String(name);
        const view = this._ctPmCamera(name, !!state);
        if (!view) return;
        const wasActive = view.active;
        const before = [view.x, view.y, view.dir, view.scale];
        view.set(state);
        if (!wasActive && !view.active) return;
        if (before[0] === view.x && before[1] === view.y && before[2] === view.dir && before[3] === view.scale) return;
        for (const id of view.drawables) {
            const drawable = this._allDrawables[id];
            if (!drawable || drawable._ctPmCameraName !== name) {
                view.drawables.delete(id);
                continue;
            }
            attach(this, drawable, view, true);
        }
        this.dirty = true;
    },

    /**
     * Bind a drawable to a camera.
     * @param {int} drawableID the drawable
     * @param {?string} name camera name
     */
    ctPmSetDrawableCamera (drawableID, name) {
        const drawable = this._allDrawables[drawableID];
        if (!drawable) return;
        name = (name === null || typeof name === 'undefined') ? null : String(name);
        const current = typeof drawable._ctPmCameraName === 'undefined' ? null : drawable._ctPmCameraName;
        if (current === name) return;
        if (current !== null) {
            const old = this._ctPmCamera(current, false);
            if (old) old.drawables.delete(drawableID);
        }
        drawable._ctPmCameraName = name;
        let view = null;
        if (name !== null) {
            view = this._ctPmCamera(name, true);
            view.drawables.add(drawableID);
            if (view.drawables.size >= view._sweepAt) {
                for (const id of view.drawables) {
                    const d = this._allDrawables[id];
                    if (!d || d._ctPmCameraName !== name) view.drawables.delete(id);
                }
                view._sweepAt = Math.max(64, view.drawables.size * 2);
            }
        }
        attach(this, drawable, view, false);
    },

    /**
     * @param {string} name camera name
     * @returns {{x: number, y: number, dir: number, scale: number}} the camera as currently drawn
     */
    ctPmGetCamera (name) {
        const view = this._ctPmCamera(String(name), false);
        if (!view) return {x: 0, y: 0, dir: 0, scale: 1};
        return {x: view.x, y: view.y, dir: view.dir, scale: view.scale};
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

module.exports = {
    install,
    applyView,
    viewScale,
    rotated,
    fencedPosition,
    CameraView
};
