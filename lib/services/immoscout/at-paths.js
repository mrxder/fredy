/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * What an ImmoScout **Austria** search path and its query parameters mean.
 *
 * `immobilienscout24.at` is a different web application from `immobilienscout24.de` - a different
 * stack, a different URL scheme (`/regional/<bundesland>/<gemeinde>/<slug>` against `/Suche/...`),
 * numeric region codes in its own state, and 24-hex object ids where the German site uses numbers.
 * Its listings, however, are syndicated into the German index and are reachable through the same
 * mobile API under an `/at/...` geocode, which is the whole reason a provider for it is 40 lines
 * rather than another 400.
 *
 * Two tables are needed for that, and they are deliberately smaller than the German ones:
 *
 * - {@link AT_PATHS} - the real estate type a path segment stands for. The German site hides most
 *   filters in the path and nowhere else, which is why `web-paths.js` is long. The Austrian site
 *   accepts the same filters as query parameters as well, so only the few that are path-only need
 *   an entry here.
 * - {@link AT_QUERY_PARAMS} - the Austrian site's own filter vocabulary. It shares no parameter
 *   name with either the German site or the mobile API (`primaryPriceTo`, `numberOfRoomsFrom`,
 *   `primaryAreaFrom`), so it is mapped here rather than in `param-support.js`, which is mobile API
 *   knowledge and has no business knowing what a website calls things.
 *
 * Everything was read off the site itself by replaying paths and parameters against it and against
 * `search/total`; see `reverse-engineered-immoscout.md`.
 */

import logger from '../logger.js';
import {
  APARTMENT_BUY,
  APARTMENT_RENT,
  BUY_TYPES,
  HOUSE_BUY,
  HOUSE_RENT,
  LIVING_BUY_SITE,
  LIVING_SPACES,
  RENT_TYPES,
} from './real-estate-types.js';

/**
 * The geocode of a search covering the whole country.
 *
 * The site spells it `oesterreich` in the path, the mobile API takes `/at` and answers 412 for
 * `/at/oesterreich`, so the one is rewritten to the other rather than passed through.
 */
export const AT_COUNTRY_GEOCODE = '/at';

/** The path segment the Austrian site anchors a regional search under. */
export const AT_SEARCH_SEGMENT = 'regional';

/** The site's own name for a country-wide search, in the position a Bundesland otherwise holds. */
const COUNTRY_SEGMENT = 'oesterreich';

/**
 * How deep the `/at` geocode namespace goes: Bundesland, then Gemeinde.
 *
 * The German namespace has a third level (`/de/berlin/berlin/mitte` resolves), the Austrian one
 * does not - every spelling of a Viennese district was replayed and every one answers 412. The
 * site does serve district pages, so a URL naming one is widened to its municipality rather than
 * refused; see {@link toGeocode}.
 */
const MAX_GEOCODE_DEPTH = 2;

/**
 * Trailing path segments that modify a search rather than name one.
 *
 * `seite-2` is the second page and `aktualitaet` is "sort by newest". Both sit *after* the type
 * slug, so they have to come off before the slug can be read. Neither needs translating: the
 * provider walks pages itself and `sortByDateParam` already sorts.
 */
const AT_PATH_MODIFIERS = [/^seite-\d+$/, /^aktualitaet$/];

/**
 * Trailing path segments that add a filter to the search the type slug names.
 *
 * The site writes a few features into the path rather than the query, after the type slug and in
 * a fixed order: `/immobilien/parkplatz/keller` is a search with a parking space *and* a cellar,
 * `/keller/parkplatz` answers 404. The order carries no meaning for the mobile API, so any order is
 * read. Each entry was checked against the site's own count for flats for sale in Innsbruck (site
 * vs. API): `parkplatz` 202/187, `keller` 288/222, `aufzug` 276/247, `barrierefrei` 167/74,
 * `neubau` 245/154, `provisionsfrei` 93/79, `pool` 2/2, `altbau` 41/16. The last two use the full
 * text search, the same stand-in the German side uses for `altbauwohnung`.
 *
 * @type {Record<string, Record<string, unknown>>}
 */
const AT_PATH_FILTERS = {
  parkplatz: { equipment: ['parking'] },
  keller: { equipment: ['cellar'] },
  aufzug: { equipment: ['lift'] },
  barrierefrei: { equipment: ['handicappedaccessible'] },
  neubau: { newbuilding: true },
  provisionsfrei: { freeofcourtageonly: true },
  altbau: { fulltext: 'altbau' },
  pool: { fulltext: 'pool' },
};

/**
 * Path filters the site serves that the mobile API cannot express.
 *
 * `moebliert` has no equipment value (`equipment=furnished` is ignored), and the full text search
 * is no stand-in: it finds 0 flats for sale in Innsbruck where the site lists 101. Refusing the URL
 * or searching for nothing would both lose the job, so the filter is dropped with a warning and the
 * search comes back wider - the same trade {@link toGeocode} makes.
 *
 * @type {Set<string>}
 */
const UNTRANSLATABLE_AT_PATH_FILTERS = new Set(['moebliert']);

/**
 * Whether a path segment is one of the site's feature filters, translatable or not.
 *
 * @param {string} segment
 * @returns {boolean}
 */
function isAtPathFilter(segment) {
  return AT_PATH_FILTERS[segment] != null || UNTRANSLATABLE_AT_PATH_FILTERS.has(segment);
}

/**
 * Base paths: the plain "what am I looking for" slugs that carry no filter.
 *
 * `immobilien` is the "Alle Immobilien" search and names four types at once, which the mobile API
 * sums - unlike a same-category pair, see {@link AMBIGUOUS_SLUGS}. `immobilie-kaufen` and
 * `immobilie-mieten` are its buying and renting halves. A flat and a house of the same deal sum as
 * well (Innsbruck: 463 flats plus 27 houses for sale answer 490); only a rent/buy pair does not. The
 * site also counts plots and garages into all three, which the mobile API keeps as separate types
 * that none of these searches include.
 *
 * @type {Record<string, string|string[]>}
 */
const AT_BASE_PATHS = {
  'wohnung-mieten': APARTMENT_RENT,
  'wohnung-kaufen': APARTMENT_BUY,
  'haus-mieten': HOUSE_RENT,
  'haus-kaufen': HOUSE_BUY,
  grundstuecke: LIVING_BUY_SITE,
  'grundstueck-kaufen': LIVING_BUY_SITE,
  immobilien: LIVING_SPACES,
  'immobilie-kaufen': BUY_TYPES,
  'immobilie-mieten': RENT_TYPES,
};

/**
 * Slugs the site serves whose type the mobile API carries no Austrian inventory for.
 *
 * `wg-zimmer-mieten` maps onto `flatshareroom`, which answers 200 with zero results for every
 * Austrian geocode (see reverse-engineered-immoscout.md). Registered, a job built on it was
 * accepted and then found nothing on every run without a word; refused, the user is told why.
 * The garage slugs are the same case: `garagebuy` and `garagerent` answer 0 for Innsbruck, where
 * the site lists 8 and 67.
 *
 * @type {Set<string>}
 */
export const UNSERVED_AT_SLUGS = new Set(['wg-zimmer-mieten', 'garage-kaufen', 'garage-mieten', 'garagen']);

/**
 * Paths that name a type *and* a filter, in the site's own spelling.
 *
 * Only the ones whose filter the mobile API can express are here. `klimatisierte-wohnungen`,
 * `passivhaus-wohnungen`, `genossenschaftswohnungen` and the holiday and agricultural slugs have no
 * counterpart in the mobile vocabulary at all, so registering them would silently drop the filter
 * and hand back a wider search than the URL asked for. `moeblierte-wohnung-mieten` is left out for
 * the reason {@link UNTRANSLATABLE_AT_PATH_FILTERS} gives.
 *
 * `terrassenwohnung-kaufen` is left out as well, although its rental twin is here: the site means
 * "a flat with a terrace" (143 for sale in Innsbruck) and the API's `terracedflat` is the building
 * type (25), so it would silently drop most of what the site shows.
 *
 * Each entry added since the first six was checked against the site for flats and houses in
 * Innsbruck (site vs. API): `wohnung-mit-garage-kaufen` 212/197, `wohnung-mit-aufzug-kaufen`
 * 292/263, `-mieten` 34/18 (of 72/35 rentals in all), `neubauwohnung-kaufen` 251/155,
 * `provisionsfreie-wohnung-kaufen` 110/97, `penthouse-kaufen` 11/12, `dachgeschosswohnung-kaufen`
 * 26/26, `maisonette-kaufen` 8/6, `einfamilienhaus-kaufen` 11/11, `doppelhaushaelfte-kaufen` 2/2,
 * `villa-kaufen` 2/2.
 *
 * @type {Array<[slug: string, realType: string, params: Record<string, unknown>]>}
 */
const AT_FILTER_PATHS = [
  ['neubauwohnung-mieten', APARTMENT_RENT, { newbuilding: true }],
  ['neubauwohnung-kaufen', APARTMENT_BUY, { newbuilding: true }],
  ['provisionsfreie-wohnung-mieten', APARTMENT_RENT, { freeofcourtageonly: true }],
  ['provisionsfreie-wohnung-kaufen', APARTMENT_BUY, { freeofcourtageonly: true }],
  ['terrassenwohnung-mieten', APARTMENT_RENT, { apartmenttypes: ['terracedflat'] }],
  ['wohnung-mit-garage-mieten', APARTMENT_RENT, { equipment: ['parking'] }],
  ['wohnung-mit-garage-kaufen', APARTMENT_BUY, { equipment: ['parking'] }],
  ['wohnung-mit-aufzug-mieten', APARTMENT_RENT, { equipment: ['lift'] }],
  ['wohnung-mit-aufzug-kaufen', APARTMENT_BUY, { equipment: ['lift'] }],
  ['penthouse-mieten', APARTMENT_RENT, { apartmenttypes: ['penthouse'] }],
  ['penthouse-kaufen', APARTMENT_BUY, { apartmenttypes: ['penthouse'] }],
  ['dachgeschosswohnung-mieten', APARTMENT_RENT, { apartmenttypes: ['roofstorey'] }],
  ['dachgeschosswohnung-kaufen', APARTMENT_BUY, { apartmenttypes: ['roofstorey'] }],
  ['maisonette-mieten', APARTMENT_RENT, { apartmenttypes: ['maisonette'] }],
  ['maisonette-kaufen', APARTMENT_BUY, { apartmenttypes: ['maisonette'] }],
  ['bungalow-kaufen', HOUSE_BUY, { buildingtypes: ['bungalow'] }],
  ['zinshaus-kaufen', HOUSE_BUY, { buildingtypes: ['multifamilyhouse'] }],
  ['einfamilienhaus-kaufen', HOUSE_BUY, { buildingtypes: ['singlefamilyhouse'] }],
  ['reihenhaus-kaufen', HOUSE_BUY, { buildingtypes: ['terracehouse'] }],
  ['doppelhaushaelfte-kaufen', HOUSE_BUY, { buildingtypes: ['semidetachedhouse'] }],
  ['villa-kaufen', HOUSE_BUY, { buildingtypes: ['villa'] }],
];

/**
 * Plural slugs, which search renting and buying at once, and what to offer instead.
 *
 * The mobile API cannot run that search. `realestatetype=apartmentrent,apartmentbuy` answers with
 * the count and the listings of whichever type is named *first* and silently ignores the other -
 * replayed on both `/at/wien/wien` and `/de/berlin/berlin`, so it is the API's behaviour and not
 * something about the Austrian feed. Four types spanning both categories do sum correctly, which is
 * why `immobilien` is registered above and `wohnungen` is not.
 *
 * Refusing is the only honest answer: registering `wohnungen` as `apartmentrent` would quietly
 * watch half the search the user pasted. The alternatives are named in the error so the fix is one
 * edit of the URL.
 *
 * @type {Record<string, string[]>}
 */
export const AMBIGUOUS_SLUGS = {
  wohnungen: ['wohnung-mieten', 'wohnung-kaufen'],
  haeuser: ['haus-mieten', 'haus-kaufen'],
  einfamilienhaeuser: ['haus-mieten', 'haus-kaufen'],
  bauernhaeuser: ['haus-mieten', 'haus-kaufen'],
  villen: ['haus-mieten', 'haus-kaufen'],
  passivhaeuser: ['haus-mieten', 'haus-kaufen'],
  penthouses: ['penthouse-mieten', 'penthouse-kaufen'],
  etagenwohnungen: ['wohnung-mieten', 'wohnung-kaufen'],
  dachgeschosswohnungen: ['dachgeschosswohnung-mieten', 'dachgeschosswohnung-kaufen'],
  terrassenwohnungen: ['terrassenwohnung-mieten', 'wohnung-kaufen'],
  altbauwohnungen: ['wohnung-mieten', 'wohnung-kaufen'],
  neubauwohnungen: ['neubauwohnung-mieten', 'neubauwohnung-kaufen'],
  'provisionsfreie-wohnungen': ['provisionsfreie-wohnung-mieten', 'provisionsfreie-wohnung-kaufen'],
  'private-wohnungen': ['wohnung-mieten', 'wohnung-kaufen'],
  'barrierefreie-wohnungen': ['wohnung-mieten', 'wohnung-kaufen'],
  'wohnungen-mit-balkon': ['wohnung-mieten', 'wohnung-kaufen'],
  'wohnungen-mit-garten': ['wohnung-mieten', 'wohnung-kaufen'],
  'wohnungen-mit-garage': ['wohnung-mit-garage-mieten', 'wohnung-mit-garage-kaufen'],
  'wohnungen-mit-aufzug': ['wohnung-mit-aufzug-mieten', 'wohnung-mit-aufzug-kaufen'],
  'wohnungen-mit-einbaukueche': ['wohnung-mieten', 'wohnung-kaufen'],
};

/**
 * Commercial slugs. The provider cannot read these searches at all - the mobile API's commercial
 * types answer with result lists that carry no `EXPOSE_RESULT` items, which is why
 * `real-estate-types.js` does not name them either.
 *
 * @type {Set<string>}
 */
export const COMMERCIAL_SLUGS = new Set(['bueros', 'geschaeftslokale', 'industrieanlagen', 'anlageobjekte']);

/** @type {Record<string, {realType: string|string[], params: Record<string, unknown>}>} */
const AT_PATHS = {};

for (const [slug, realType] of Object.entries(AT_BASE_PATHS)) {
  AT_PATHS[slug] = { realType, params: {} };
}
for (const [slug, realType, params] of AT_FILTER_PATHS) {
  AT_PATHS[slug] = { realType, params };
}

/**
 * Paths the site generates from a number rather than from a fixed vocabulary.
 *
 * Only the `-mieten` / `-kaufen` halves are here. Their plural counterparts (`3-zimmer-wohnungen`,
 * `wohnungen-bis-70-m2`) search both deals and are refused for the reason {@link AMBIGUOUS_SLUGS}
 * gives; {@link ambiguousAlternativesFor} builds their suggestion from the same numbers.
 *
 * @type {Array<{pattern: RegExp, resolve: (groups: Record<string, string>) => {realType: string, params: Record<string, unknown>}, example: string}>}
 */
const AT_PATH_PATTERNS = [
  {
    // "3-zimmer-wohnung-mieten" - an exact room count, as the site's own filter sets it.
    pattern: /^(?<rooms>\d+)-zimmer-wohnung-(?<deal>mieten|kaufen)$/,
    resolve: ({ rooms, deal }) => ({
      realType: deal === 'mieten' ? APARTMENT_RENT : APARTMENT_BUY,
      params: { numberofrooms: `${toDecimal(rooms)}-${toDecimal(rooms, 0.5)}` },
    }),
    example: '3-zimmer-wohnung-mieten',
  },
  {
    // "wohnung-ab-3-zimmer-mieten" - a minimum room count, open ended.
    pattern: /^wohnung-ab-(?<rooms>\d+)-zimmer-(?<deal>mieten|kaufen)$/,
    resolve: ({ rooms, deal }) => ({
      realType: deal === 'mieten' ? APARTMENT_RENT : APARTMENT_BUY,
      params: { numberofrooms: `${toDecimal(rooms)}-` },
    }),
    example: 'wohnung-ab-3-zimmer-mieten',
  },
  {
    // "wohnung-bis-1100-euro-mieten" - a maximum rent. The site states Bruttomiete here, which is
    // the mobile API's `calculatedtotalrent`, and that value exists for apartment rentals alone.
    pattern: /^wohnung-bis-(?<price>\d+)-euro-(?<deal>mieten|kaufen)$/,
    resolve: ({ price, deal }) =>
      deal === 'mieten'
        ? { realType: APARTMENT_RENT, params: { price: `-${toDecimal(price)}`, pricetype: 'calculatedtotalrent' } }
        : { realType: APARTMENT_BUY, params: { price: `-${toDecimal(price)}` } },
    example: 'wohnung-bis-1100-euro-mieten',
  },
  {
    // "wohnung-ab-1100-euro-mieten" - a minimum, same reading.
    pattern: /^wohnung-ab-(?<price>\d+)-euro-(?<deal>mieten|kaufen)$/,
    resolve: ({ price, deal }) =>
      deal === 'mieten'
        ? { realType: APARTMENT_RENT, params: { price: `${toDecimal(price)}-`, pricetype: 'calculatedtotalrent' } }
        : { realType: APARTMENT_BUY, params: { price: `${toDecimal(price)}-` } },
    example: 'wohnung-ab-1100-euro-mieten',
  },
  {
    // "wohnung-bis-70-m2-mieten" - a maximum living space.
    pattern: /^wohnung-bis-(?<size>\d+)-m2-(?<deal>mieten|kaufen)$/,
    resolve: ({ size, deal }) => ({
      realType: deal === 'mieten' ? APARTMENT_RENT : APARTMENT_BUY,
      params: { livingspace: `-${toDecimal(size)}` },
    }),
    example: 'wohnung-bis-70-m2-mieten',
  },
  {
    // "wohnung-ab-100-m2-mieten" - a minimum living space.
    pattern: /^wohnung-ab-(?<size>\d+)-m2-(?<deal>mieten|kaufen)$/,
    resolve: ({ size, deal }) => ({
      realType: deal === 'mieten' ? APARTMENT_RENT : APARTMENT_BUY,
      params: { livingspace: `${toDecimal(size)}-` },
    }),
    example: 'wohnung-ab-100-m2-mieten',
  },
];

/**
 * Plural counterparts of the generated paths, and the singular slugs to offer instead.
 *
 * Kept next to the patterns rather than in {@link AMBIGUOUS_SLUGS} because there is one of these
 * per number the site publishes, and listing them all would be a table that grows whenever
 * ImmoScout adds a room count.
 *
 * @type {Array<{pattern: RegExp, alternatives: (groups: Record<string, string>) => string[]}>}
 */
const AMBIGUOUS_PATTERNS = [
  {
    pattern: /^(?<rooms>\d+)-zimmer-wohnungen$/,
    alternatives: ({ rooms }) => [`${rooms}-zimmer-wohnung-mieten`, `${rooms}-zimmer-wohnung-kaufen`],
  },
  {
    pattern: /^wohnungen-ab-(?<rooms>\d+)-zimmer$/,
    alternatives: ({ rooms }) => [`wohnung-ab-${rooms}-zimmer-mieten`, `wohnung-ab-${rooms}-zimmer-kaufen`],
  },
  {
    pattern: /^wohnungen-(?<bound>bis|ab)-(?<size>\d+)-m2$/,
    alternatives: ({ bound, size }) => [`wohnung-${bound}-${size}-m2-mieten`, `wohnung-${bound}-${size}-m2-kaufen`],
  },
];

/**
 * A number as the mobile API spells its range bounds: always with a decimal place.
 *
 * `numberofrooms=3-3.5` answers 412 where `3.0-3.5` answers 200, and the German translator emits
 * the same shape, so the two portals cannot drift apart on it.
 *
 * @param {string|number} value
 * @param {number} [add] Added before formatting, for the upper end of an exact room count.
 * @returns {string}
 */
function toDecimal(value, add = 0) {
  return (Number(value) + add).toFixed(1);
}

/**
 * The Austrian site's filter vocabulary, mapped onto the mobile API's.
 *
 * Only range filters are here, and that is not an omission: they are the ones the site states as
 * two independent `...From` / `...To` parameters where the mobile API wants a single `min-max`
 * string, so they need assembling rather than renaming. `outdoorSpaces` is the one enum filter with
 * a counterpart and has its own table, {@link AT_OUTDOOR_SPACES}. The remaining boolean and enum
 * filters (`lift`, `pictureTags`, `isSocialHousing`, `isPrivateInsertion`) either have no
 * counterpart in the mobile vocabulary or are worded differently enough that guessing at them would
 * be inventing a search; they are reported as untranslated instead.
 *
 * @type {Record<string, {param: string, bound: 'min'|'max'}>}
 */
export const AT_QUERY_PARAMS = {
  primaryPriceFrom: { param: 'price', bound: 'min' },
  primaryPriceTo: { param: 'price', bound: 'max' },
  primaryAreaFrom: { param: 'livingspace', bound: 'min' },
  primaryAreaTo: { param: 'livingspace', bound: 'max' },
  numberOfRoomsFrom: { param: 'numberofrooms', bound: 'min' },
  numberOfRoomsTo: { param: 'numberofrooms', bound: 'max' },
};

/**
 * The Austrian site's `outdoorSpaces` values, mapped onto the mobile API's `equipment` values.
 *
 * Both sides are an "any of" filter, which is what makes this a translation rather than a guess:
 * `equipment=balcony,garden` answers with *more* listings than either value alone, unlike
 * `parking,cellar`, which narrows. The mobile API has no separate terrace or loggia, and its
 * `balcony` is the German index's "Balkon/Terrasse" flag - in Innsbruck it matches 346 flats for
 * sale where the site counts 382 for `BALCONY,TERRACE,LOGGIA` and 247 for `BALCONY` alone. So all
 * three collapse onto `balcony`, and naming only some of them widens the search to all three.
 *
 * @type {Record<string, string>}
 */
export const AT_OUTDOOR_SPACES = {
  BALCONY: 'balcony',
  TERRACE: 'balcony',
  LOGGIA: 'balcony',
  GARDEN: 'garden',
};

/** The site's values that the mobile API can only tell apart as one, see {@link AT_OUTDOOR_SPACES}. */
const AT_BALCONY_LIKE = Object.keys(AT_OUTDOOR_SPACES).filter((value) => AT_OUTDOOR_SPACES[value] === 'balcony');

/**
 * Translates the site's `outdoorSpaces` into the mobile API's `equipment`.
 *
 * @param {string|string[]} rawValue One value, a comma separated list, or the list already split.
 * @returns {string[]} The `equipment` values, without duplicates; empty when nothing was usable.
 */
function translateOutdoorSpaces(rawValue) {
  const values = (Array.isArray(rawValue) ? rawValue : [rawValue])
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value !== '');

  const equipment = new Set();
  for (const value of values) {
    if (AT_OUTDOOR_SPACES[value] != null) {
      equipment.add(AT_OUTDOOR_SPACES[value]);
    } else {
      logger.warn(
        `ImmoScout AT: no translator for outdoor space "${value}", the value is ignored. ` +
          `Please report the search URL at https://github.com/orangecoding/fredy/issues so it can be added.`,
      );
    }
  }

  const balconyLike = values.filter((value) => AT_BALCONY_LIKE.includes(value));
  if (balconyLike.length > 0 && AT_BALCONY_LIKE.some((value) => !balconyLike.includes(value))) {
    logger.warn(
      `ImmoScout AT: the mobile API cannot tell ${AT_BALCONY_LIKE.join(', ')} apart, ` +
        `so "outdoorSpaces=${balconyLike.join(',')}" searches for any of them.`,
    );
  }

  return [...equipment];
}

/**
 * Query parameters the Austrian site appends that are not a filter: paging, sorting and tracking.
 * Same idea as the German translator's noise list, in the Austrian site's spelling.
 *
 * @type {Set<string>}
 */
const AT_IGNORED_PARAMS = new Set(['page', 'pageIndex', 'pageSize', 'sort', 'sorting', 'searchId', 'referrer']);

/** Tracking parameter families, same idea as {@link AT_IGNORED_PARAMS}. */
const AT_IGNORED_PREFIXES = ['utm_', 'cmp_'];

/**
 * Whether a parameter is website noise rather than a filter.
 *
 * @param {string} param
 * @returns {boolean}
 */
function isAtNoise(param) {
  return AT_IGNORED_PARAMS.has(param) || AT_IGNORED_PREFIXES.some((prefix) => param.startsWith(prefix));
}

/**
 * The single-deal slugs to offer for a plural one, or null when it is not a plural slug.
 *
 * @param {string} slug Last path segment of the web URL.
 * @returns {string[]|null}
 */
export function ambiguousAlternativesFor(slug) {
  if (AMBIGUOUS_SLUGS[slug]) {
    return AMBIGUOUS_SLUGS[slug];
  }
  for (const { pattern, alternatives } of AMBIGUOUS_PATTERNS) {
    const match = slug.match(pattern);
    if (match) {
      return alternatives(match.groups);
    }
  }
  return null;
}

/**
 * Resolves the type-naming segment of an Austrian search path to the search it stands for.
 *
 * @param {string} slug Last path segment, e.g. `wohnung-mieten`.
 * @returns {{realType: string|string[], params: Record<string, unknown>} | null} `null` when the
 *   site serves a path this table does not know.
 */
export function resolveAtPath(slug) {
  if (AT_PATHS[slug]) {
    return AT_PATHS[slug];
  }

  for (const { pattern, resolve } of AT_PATH_PATTERNS) {
    const match = slug.match(pattern);
    if (match) {
      return resolve(match.groups);
    }
  }

  return null;
}

/**
 * Every Austrian search path the translator knows, literal ones plus one example per generated
 * pattern. Exposed for the same reason the German one is: so a test can replay the whole catalogue
 * against the live mobile API and notice when a path stops resolving.
 *
 * @returns {string[]}
 */
export function listKnownAtPaths() {
  return [...Object.keys(AT_PATHS), ...AT_PATH_PATTERNS.map(({ example }) => example)];
}

/**
 * The path segments that name the area, the type slug, and the feature filters after it, with the
 * site's modifiers taken off the end.
 *
 * @param {string[]} segments Path segments of the web URL, leading empty one included.
 * @returns {{area: string[], slug: string|null, filters: string[]}} `filters` in path order, see
 *   {@link AT_PATH_FILTERS}.
 */
export function splitAtPath(segments) {
  const meaningful = segments.filter((segment) => segment !== '');
  // `/regional` itself, then the area, then the type slug, then its filters, then the site's own
  // modifiers.
  const withoutAnchor = meaningful.slice(1);
  let end = withoutAnchor.length;
  while (end > 0 && AT_PATH_MODIFIERS.some((modifier) => modifier.test(withoutAnchor[end - 1]))) {
    end -= 1;
  }
  let filterStart = end;
  while (filterStart > 0 && isAtPathFilter(withoutAnchor[filterStart - 1])) {
    filterStart -= 1;
  }
  const filters = withoutAnchor.slice(filterStart, end);
  const relevant = withoutAnchor.slice(0, filterStart);
  if (relevant.length < 2) {
    return { area: relevant, slug: null, filters };
  }
  return { area: relevant.slice(0, -1), slug: relevant.at(-1), filters };
}

/**
 * Merges search parameters the way the site stacks filters: equipment values accumulate and full
 * text terms are joined (the API reads `fulltext=altbau pool` as both words), everything else is
 * replaced by `later`.
 *
 * @param {Record<string, unknown>} earlier
 * @param {Record<string, unknown>} later
 * @returns {Record<string, unknown>}
 */
export function mergeAtParams(earlier, later) {
  const merged = { ...earlier, ...later };
  if (earlier.equipment != null && later.equipment != null) {
    merged.equipment = [...new Set([earlier.equipment, later.equipment].flat())];
  }
  if (earlier.fulltext != null && later.fulltext != null) {
    merged.fulltext = [...new Set([earlier.fulltext, later.fulltext])].join(' ');
  }
  return merged;
}

/**
 * Translates the feature filters written after the type slug into mobile API parameters.
 *
 * @param {string[]} filters Path segments as {@link splitAtPath} returns them.
 * @returns {Record<string, unknown>}
 */
export function resolveAtPathFilters(filters) {
  /** @type {Record<string, unknown>} */
  let params = {};
  for (const filter of filters) {
    if (UNTRANSLATABLE_AT_PATH_FILTERS.has(filter)) {
      logger.warn(
        `ImmoScout AT: the mobile API cannot filter on "${filter}", the filter is ignored and the search comes back wider.`,
      );
      continue;
    }
    params = mergeAtParams(params, AT_PATH_FILTERS[filter]);
  }
  return params;
}

/**
 * The mobile API geocode for an Austrian search path's area.
 *
 * Two things are not a straight join. `oesterreich` is the site's word for the whole country and
 * the API's is `/at`, and anything below the Gemeinde - a Viennese district, say - has no geocode
 * at all, so the search is widened to the municipality above it. Widening is the same trade the
 * parameter filter makes: a search that comes back wider than asked for still finds the flat, where
 * a 412 finds nothing and reads like an empty result.
 *
 * @param {string[]} area Area segments of the path, e.g. `['wien', 'wien']`.
 * @returns {string} A geocode the mobile API accepts.
 */
export function toGeocode(area) {
  if (area.length === 0 || (area.length === 1 && area[0] === COUNTRY_SEGMENT)) {
    return AT_COUNTRY_GEOCODE;
  }

  if (area.length > MAX_GEOCODE_DEPTH) {
    logger.warn(
      `ImmoScout AT: "${area.slice(MAX_GEOCODE_DEPTH).join('/')}" is below the smallest area the mobile API knows. ` +
        `Searching all of ${area[MAX_GEOCODE_DEPTH - 1]} instead - narrow the job down with an area filter if that is too wide.`,
    );
    return `${AT_COUNTRY_GEOCODE}/${area.slice(0, MAX_GEOCODE_DEPTH).join('/')}`;
  }

  return `${AT_COUNTRY_GEOCODE}/${area.join('/')}`;
}

/**
 * Translates the Austrian site's query parameters into the mobile API's.
 *
 * The two halves of a range arrive as separate parameters and leave as one, so a URL stating only
 * an upper bound yields `price=-1200.0` - an empty lower bound, exactly the shape ImmoScout's own
 * search pages emit. Anything with no counterpart is reported rather than dropped in silence, for
 * the reason `keepSupported` gives: a filter the user set and did not get is worth a log line.
 *
 * @param {Record<string, unknown>} queryParams Query parameters of the web URL.
 * @returns {Record<string, string|string[]>} Parameters for the mobile API.
 */
export function translateAtQueryParams(queryParams) {
  /** @type {Record<string, {min?: string, max?: string}>} */
  const ranges = {};
  /** @type {Record<string, string[]>} */
  const lists = {};

  for (const [name, rawValue] of Object.entries(queryParams)) {
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value == null || value === '') {
      continue;
    }

    if (name === 'outdoorSpaces') {
      const equipment = translateOutdoorSpaces(rawValue);
      if (equipment.length > 0) {
        lists.equipment = equipment;
      }
      continue;
    }

    const mapping = AT_QUERY_PARAMS[name];
    if (mapping != null) {
      // A bound that is not a number (`abc`, a German `1.200` that reads as 1.2) became `-NaN` or
      // a bound nobody set, and the API then refused the search or ran a different one. Dropped
      // with a warning instead, like any other filter this cannot read.
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) {
        logger.warn(`ImmoScout AT: "${name}=${value}" is not a usable bound, the filter is ignored.`);
        continue;
      }
      ranges[mapping.param] = { ...ranges[mapping.param], [mapping.bound]: toDecimal(number) };
    } else if (!isAtNoise(name)) {
      logger.warn(
        `ImmoScout AT: no translator for query parameter "${name}=${value}", the filter is ignored. ` +
          `Please report the search URL at https://github.com/orangecoding/fredy/issues so it can be added.`,
      );
    }
  }

  return {
    ...Object.fromEntries(Object.entries(ranges).map(([param, { min, max }]) => [param, `${min ?? ''}-${max ?? ''}`])),
    ...lists,
  };
}
