/**
 * @fileoverview PenguinMod compatibility.
 */

const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

/**
 * Non-finite values.
 * @param {number} x value
 * @param {number} fallback used when x isn't finite
 * @returns {number} x or fallback
 */
const finite = (x, fallback) => (Number.isFinite(x) ? x : fallback);

const MAX_GEOMETRY = 1000;

const channel = x => ((clamp(finite(x, 0), -100, 100) / 100) * 4) + 1;

const EFFECTS = {
    red: {uniformName: 'u_red', converter: channel, shapeChanges: false, colour: true},
    green: {uniformName: 'u_green', converter: channel, shapeChanges: false, colour: true},
    blue: {uniformName: 'u_blue', converter: channel, shapeChanges: false, colour: true},
    opaque: {
        uniformName: 'u_opaque',
        converter: x => clamp(Math.ceil(finite(x, 0)), 1, 100),
        shapeChanges: false,
        colour: true
    },
    saturation: {
        uniformName: 'u_saturation',
        converter: x => (clamp(finite(x, 0), -1e6, 1e6) / 100) + 1,
        shapeChanges: false,
        colour: true
    },
    tintColor: {
        uniformName: 'u_tintColor',
        converter: x => clamp(Math.floor(finite(x, 0)), 1, 0x1000000) - 1,
        shapeChanges: false,
        colour: true
    },
    horizontal_shear: {
        uniformName: 'u_horizontalShear',
        converter: x => clamp(finite(x, 0) / 10, -MAX_GEOMETRY, MAX_GEOMETRY),
        shapeChanges: true,
        geometry: true
    },
    vertical_shear: {
        uniformName: 'u_verticalShear',
        converter: x => clamp(finite(x, 0) / 10, -MAX_GEOMETRY, MAX_GEOMETRY),
        shapeChanges: true,
        geometry: true
    },
    repeat_x: {
        uniformName: 'u_repeatX',
        converter: x => clamp(finite(x, 1), -MAX_GEOMETRY, MAX_GEOMETRY),
        shapeChanges: true,
        geometry: true
    },
    repeat_y: {
        uniformName: 'u_repeatY',
        converter: x => clamp(finite(x, 1), -MAX_GEOMETRY, MAX_GEOMETRY),
        shapeChanges: true,
        geometry: true
    }
};

const EFFECT_INFO_REF = {value: null};

const masks = {
    colour: 0,
    repeatX: 0,
    repeatY: 0,
    hShear: 0,
    vShear: 0,
    color: 0,
    brightness: 0,
    ghost: 0
};

/**
 * Add the new effects to ShaderManager.EFFECT_INFO, after the vanilla ones.
 * @param {object} effectInfo effectInfo
 */
const register = effectInfo => {
    let bit = Object.keys(effectInfo).length;
    for (const name of Object.keys(EFFECTS)) {
        if (Object.prototype.hasOwnProperty.call(effectInfo, name)) continue;
        effectInfo[name] = Object.assign({mask: 1 << bit++}, EFFECTS[name]);
    }
    for (const name of Object.keys(EFFECTS)) {
        if (EFFECTS[name].colour) masks.colour |= effectInfo[name].mask;
    }
    masks.repeatX = effectInfo.repeat_x.mask;
    masks.repeatY = effectInfo.repeat_y.mask;
    masks.hShear = effectInfo.horizontal_shear.mask;
    masks.vShear = effectInfo.vertical_shear.mask;
    masks.color = effectInfo.color.mask;
    masks.brightness = effectInfo.brightness.mask;
    masks.ghost = effectInfo.ghost.mask;
};

/**
 * Recompute a drawable's quad transform after a geometry effect changed.
 * @param {Drawable} drawable drawable
 */
const updateGeometry = drawable => {
    const effects = drawable.enabledEffects;
    const u = drawable._uniforms;
    const rx = (effects & masks.repeatX) ? u.u_repeatX : 1;
    const ry = (effects & masks.repeatY) ? u.u_repeatY : 1;
    const h = (effects & masks.hShear) ? u.u_horizontalShear : 0;
    const v = (effects & masks.vShear) ? u.u_verticalShear : 0;
    if (rx === 1 && ry === 1 && h === 0 && v === 0) {
        drawable._ctPmGeometry = null;
    } else {
        drawable._ctPmGeometry = [rx, -h, -v, ry, ((1 - rx) / 2) + (h / 2), ((1 - ry) / 2) + (v / 2)];
    }
    drawable.setTransformDirty();
};

/**
 * Compose the drawable's model matrix with its geometry effect.
 * @param {Drawable} drawable drawable
 * @param {Float32Array} m m
 */
const applyGeometry = (drawable, m) => {
    const [a, b, c, d, e, f] = drawable._ctPmGeometry;
    const m0 = m[0];
    const m1 = m[1];
    const m4 = m[4];
    const m5 = m[5];
    m[0] = (m0 * a) + (m4 * c);
    m[1] = (m1 * a) + (m5 * c);
    m[4] = (m0 * b) + (m4 * d);
    m[5] = (m1 * b) + (m5 * d);
    m[12] += (m0 * e) + (m4 * f);
    m[13] += (m1 * e) + (m5 * f);
};

/**
 * Texture tiling of repeat_x/y.
 * @param {Drawable} drawable the drawable
 * @param {twgl.v3} dst dst
 * @param {number} effects enabled effect bits
 */
const transformPoint = (drawable, dst, effects) => {
    const u = drawable._uniforms;
    if ((effects & masks.repeatX) && u.u_repeatX !== 1) {
        const t = dst[0] * u.u_repeatX;
        dst[0] = t - Math.floor(t);
    }
    if ((effects & masks.repeatY) && u.u_repeatY !== 1) {
        const t = dst[1] * u.u_repeatY;
        dst[1] = t - Math.floor(t);
    }
};

const EPSILON = 1e-3;

const __hsv = [0, 0, 0];
const __rgb = [0, 0, 0];

/**
 * The fragment shader's branchless RGB → HSV.
 * @param {Array<number>} rgb input
 * @param {Array<number>} dst output [h, s, v]
 * @returns {Array<number>} dst dst
 */
const rgbToHsv = (rgb, dst) => {
    const r = rgb[0];
    const g = rgb[1];
    const b = rgb[2];
    const t1x = b > g ? b : g;
    const t1y = b > g ? g : b;
    const t1z = b > g ? -1 : 0;
    const t1w = b > g ? 2 / 3 : -1 / 3;
    const rMax = r > t1x;
    const t2x = rMax ? r : t1x;
    const t2y = t1y;
    const t2z = rMax ? t1z : t1w;
    const t2w = rMax ? t1x : r;
    const m = Math.min(t2y, t2w);
    const chroma = t2x - m;
    dst[0] = Math.abs(t2z + ((t2w - t2y) / ((6 * chroma) + EPSILON)));
    dst[1] = chroma / (t2x + EPSILON);
    dst[2] = t2x;
    return dst;
};

/**
 * The fragment shader's HSV → RGB.
 * @param {Array<number>} hsv input
 * @param {Array<number>} dst output
 * @returns {Array<number>} dst dst
 */
const hsvToRgb = (hsv, dst) => {
    const h = hsv[0];
    const r = clamp(Math.abs((h * 6) - 3) - 1, 0, 1);
    const g = clamp(2 - Math.abs((h * 6) - 2), 0, 1);
    const b = clamp(2 - Math.abs((h * 6) - 4), 0, 1);
    const c = hsv[2] * hsv[1];
    dst[0] = (r * c) + hsv[2] - c;
    dst[1] = (g * c) + hsv[2] - c;
    dst[2] = (b * c) + hsv[2] - c;
    return dst;
};

/**
 * The whole colour pipeline of the fragment shader, on the CPU, for a drawable that has at least.
 * @param {Drawable} drawable the drawable
 * @param {Uint8ClampedArray} inOutColor inOutColor
 * @param {number} effects effects
 * @returns {Uint8ClampedArray} inOutColor inOutColor
 */
const transformColor = (drawable, inOutColor, effects) => {
    const u = drawable.getUniforms();
    const info = EFFECT_INFO_REF.value;
    let r = inOutColor[0] / 255;
    let g = inOutColor[1] / 255;
    let b = inOutColor[2] / 255;
    let a = inOutColor[3] / 255;

    const color = (effects & masks.color) !== 0;
    const brightness = (effects & masks.brightness) !== 0;
    const saturation = (effects & info.saturation.mask) !== 0;
    const tint = (effects & info.tintColor.mask) !== 0;
    if (color || brightness || saturation || tint) {
        const divisor = a + EPSILON;
        __rgb[0] = clamp(r / divisor, 0, 1);
        __rgb[1] = clamp(g / divisor, 0, 1);
        __rgb[2] = clamp(b / divisor, 0, 1);
        if (color) {
            const hsv = rgbToHsv(__rgb, __hsv);
            const minLightness = 0.11 / 2;
            const minSaturation = 0.09;
            if (hsv[2] < minLightness) {
                hsv[0] = 0;
                hsv[1] = 1;
                hsv[2] = minLightness;
            } else if (hsv[1] < minSaturation) {
                hsv[0] = 0;
                hsv[1] = minSaturation;
            }
            const hue = hsv[0] + u.u_color;
            hsv[0] = hue - Math.floor(hue);
            hsvToRgb(hsv, __rgb);
        }
        if (saturation) {
            const hsv = rgbToHsv(__rgb, __hsv);
            hsv[1] *= u.u_saturation;
            hsvToRgb(hsv, __rgb);
        }
        if (tint) {
            const t = u.u_tintColor;
            __rgb[0] *= ((t >> 16) & 255) / 255;
            __rgb[1] *= ((t >> 8) & 255) / 255;
            __rgb[2] *= (t & 255) / 255;
        }
        if (brightness) {
            __rgb[0] = clamp(__rgb[0] + u.u_brightness, 0, 1);
            __rgb[1] = clamp(__rgb[1] + u.u_brightness, 0, 1);
            __rgb[2] = clamp(__rgb[2] + u.u_brightness, 0, 1);
        }
        r = __rgb[0] * divisor;
        g = __rgb[1] * divisor;
        b = __rgb[2] * divisor;
    }
    if (effects & masks.ghost) {
        r *= u.u_ghost;
        g *= u.u_ghost;
        b *= u.u_ghost;
        a *= u.u_ghost;
    }
    if (effects & info.red.mask) r *= u.u_red;
    if (effects & info.green.mask) g *= u.u_green;
    if (effects & info.blue.mask) b *= u.u_blue;
    if (effects & info.opaque.mask) a *= u.u_opaque;

    inOutColor[0] = r * 255;
    inOutColor[1] = g * 255;
    inOutColor[2] = b * 255;
    inOutColor[3] = a * 255;
    return inOutColor;
};

const registerWithRef = effectInfo => {
    register(effectInfo);
    EFFECT_INFO_REF.value = effectInfo;
};

module.exports = {
    EFFECTS,
    masks,
    register: registerWithRef,
    updateGeometry,
    applyGeometry,
    transformPoint,
    transformColor,
    rgbToHsv,
    hsvToRgb
};
