import { createHash } from 'node:crypto';

const hashes = Object.create(null);

//TODO shorter?
const hash_length = 10;

/**
 * @param {string} input
 * @returns {string}
 */
export function safeBase64Hash(input) {
    if (hashes[input]) {
        return hashes[input];
    }
    //TODO if performance really matters, use a faster one like xx-hash etc.
    // should be evenly distributed because short input length and similarities in paths could cause collisions otherwise
    // OR DON'T USE A HASH AT ALL, what about a simple counter?
    const md5 = createHash('md5');
    md5.update(input);
    const hash = toSafe(md5.digest('base64')).substr(0, hash_length);
    hashes[input] = hash;
    return hash;
}

/**
 * @type {{ [key: string]: string }}
 */
const replacements = {
    '+': '-',
    '/': '_',
    '=': ''
};

const replaceRE = new RegExp(`[${Object.keys(replacements).join('')}]`, 'g');

/**
 *
 * @param {string} base64
 * @returns {string}
 */
function toSafe(base64) {
    return base64.replace(replaceRE, (x) => replacements[x]);
}
