/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * immo.tt.com, the property marketplace of the Tiroler Tageszeitung and the portal most of Tyrol
 * advertises on.
 *
 * Both the search page and the advert are rendered on the server, so a plain request is enough -
 * no headless browser, and nothing to wait for. The search page carries a card per advert with the
 * title, the municipality, the living area, the room count and the price. The advert adds what the
 * card leaves out: the street, the coordinates, the full text and the fact table with the Baujahr
 * and the HWB class, which {@link fetchDetails} reads when the user has detail fetching enabled.
 *
 * The site also answers `/immobilien?count=1&f[...]=...` with `{"count": n}`, which is what its own
 * search form shows while filters are being picked. Nothing here needs it: a run fetches the result
 * page anyway, and a count cannot tell a new advert from one that replaced a removed one.
 */

import * as cheerio from 'cheerio';
import queryString from 'query-string';
import { buildHash, isOneOf } from '../utils.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import { extractNumber } from '../utils/extract-number.js';
import { readJsonLdPrice } from '../utils/priceExtractors.js';
import { normalizeBuildYear, normalizeEnergyClass } from '../utils/buildingFacts.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const BASE_URL = 'https://immo.tt.com/';

/** A browser's user agent. The site answers either way, but a bare client is the first to be rate limited. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15';

const HEADERS = { 'User-Agent': USER_AGENT, 'Accept-Language': 'de-AT,de;q=0.9' };

/**
 * The "neueste Anzeigen zuerst" entry of the site's sort dropdown, as the query parameter it writes.
 * `displays_at` is when an advert went (back) online, so a refreshed advert moves up as well.
 */
const SORT_BY_DATE_PARAM = 's[displays_at]=desc';

/**
 * Adverts per result page. The site defaults to 20 and serves at least 100; 50 covers a busy day in
 * Innsbruck in one request without fetching a megabyte of markup every run.
 */
const PAGE_SIZE = 50;

/**
 * The Bundesländer as the site spells them in an advert's path, and as a geocoder wants them.
 *
 * The card names the municipality alone ("Innsbruck", "Hötting"), which is ambiguous across Austria
 * and, for a district like Hötting, not a municipality at all. The state the path names is added so
 * the geocoder is at least searching the right part of the country.
 *
 * @type {Record<string, string>}
 */
const STATES = {
  burgenland: 'Burgenland',
  kaernten: 'Kärnten',
  niederoesterreich: 'Niederösterreich',
  oberoesterreich: 'Oberösterreich',
  salzburg: 'Salzburg',
  steiermark: 'Steiermark',
  tirol: 'Tirol',
  vorarlberg: 'Vorarlberg',
  wien: 'Wien',
};

/**
 * Collapse whitespace, including the non-breaking spaces the cards separate figures from units with.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function cleanText(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Turns a possibly relative url into an absolute one.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function toAbsoluteUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, BASE_URL).href;
  } catch {
    return null;
  }
}

/**
 * The search URL to request: the job's own filters, sorted newest first, one page of {@link PAGE_SIZE}.
 *
 * Every other sort key is dropped, not just overridden. The site applies them in the order they
 * appear, so a URL copied while sorted by price (`s[price]=asc`) kept sorting by price with the date
 * sort added behind it, and the newest adverts could sit on page five.
 *
 * @param {string} url The job's search URL.
 * @returns {string}
 */
export function buildSearchUrl(url) {
  const { url: base, query } = queryString.parseUrl(url);
  const filters = Object.fromEntries(
    Object.entries(query).filter(([key]) => !key.startsWith('s[') && key !== 'page' && key !== 'limit'),
  );
  return `${base}?${queryString.stringify({
    ...filters,
    ...queryString.parse(SORT_BY_DATE_PARAM),
    limit: PAGE_SIZE,
  })}`;
}

/**
 * Sort one card's figures into size, rooms and price by what they say rather than where they sit.
 *
 * The three cells are always in that order today, but a card for a parking space or a plot leaves
 * one of them as "-", and reading by position is exactly what breaks when the site drops a cell.
 *
 * @param {string[]} cells The text of each figure cell.
 * @returns {{size: string|null, rooms: string|null, price: string|null}}
 */
function readFigures(cells) {
  const figures = { size: null, rooms: null, price: null };
  for (const cell of cells) {
    if (/m²|m2/.test(cell)) figures.size = cell;
    else if (/Zimmer/i.test(cell)) figures.rooms = cell;
    else if (/€|Preis/i.test(cell)) figures.price = cell;
  }
  return figures;
}

/**
 * Read the result cards out of a search page.
 *
 * @param {string} html
 * @returns {Object[]}
 */
export function parseSearchPage(html) {
  const $ = cheerio.load(html);
  return $('.serp-card-container')
    .toArray()
    .map((element) => {
      const card = $(element);
      const cells = card
        .find('.col-span-4')
        .toArray()
        .map((cell) => cleanText($(cell).text()) ?? '');
      return {
        id: card.attr('data-id') ?? null,
        link: card.find('a[href^="/immobilien/"]').first().attr('href') ?? null,
        title: cleanText(card.find('h2').first().text()),
        location: cleanText(
          card.find('h2').closest('.col-span-12').nextAll('.col-span-12').first().find('p').first().text(),
        ),
        image: card.find('img.object-cover').first().attr('src') ?? null,
        ...readFigures(cells),
      };
    });
}

/**
 * @param {string} url The job's search URL, with the sort parameter already appended.
 * @returns {Promise<Object[]>}
 */
async function getListings(url) {
  const response = await fetch(buildSearchUrl(url), { headers: HEADERS });

  if (!response.ok) {
    logger.error(`Error fetching data from immo.tt.com: ${response.status} ${response.statusText}`);
    return [];
  }

  const cards = parseSearchPage(await response.text());
  if (cards.length === 0) {
    logger.warn('immo.tt.com returned a page without adverts. The search URL may be wrong, or nothing matches it.');
  }
  return cards;
}

/**
 * The Bundesland an advert's path names: `/immobilien/<type>/<subtype>/<state>/<district>/<id>`.
 *
 * @param {string|null} link
 * @returns {string|null}
 */
function stateOf(link) {
  if (!link) return null;
  try {
    const segments = new URL(link).pathname.split('/').filter(Boolean);
    return STATES[segments[3]] ?? null;
  } catch {
    return null;
  }
}

/**
 * The card's municipality with its Bundesland, which is as precise as the search page gets.
 *
 * @param {Object} o A raw card.
 * @param {string|null} link The advert's absolute link.
 * @returns {string|null}
 */
function buildAddress(o, link) {
  const parts = [o.location, stateOf(link)].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * A card's price as a number: "€ 450.000" is 450000, "€ 1.799,3" is 1799.3, "Preis auf Anfrage" is
 * unknown. The currency comes first on this site, and `extractNumber` reads from the first
 * character, so it is cut off before the number is read.
 *
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
function readPrice(value) {
  if (value == null) return null;
  const digits = String(value).replace(/^\D+/, '');
  return digits.length === 0 ? null : extractNumber(digits);
}

/**
 * @param {any} o
 * @returns {ParsedListing}
 */
function normalize(o) {
  const link = toAbsoluteUrl(o.link);
  const price = readPrice(o.price);
  return {
    id: buildHash(o.id, price == null ? null : String(price)),
    link,
    title: o.title,
    price,
    size: extractNumber(o.size),
    rooms: extractNumber(o.rooms),
    address: buildAddress(o, link),
    image: toAbsoluteUrl(o.image),
    description: o.description ?? null,
  };
}

/**
 * The schema.org `Product` an advert page describes itself with.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {any|null}
 */
function readProduct($) {
  for (const block of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(block).text());
      if (data?.['@type'] === 'Product') return data;
    } catch {
      // Another block may still be readable.
    }
  }
  return null;
}

/**
 * The street address the advert publishes, as "Innrain, 6020 Innsbruck".
 *
 * @param {any} product
 * @returns {string|null}
 */
function readStreetAddress(product) {
  const address = product?.location?.address;
  if (address == null) return null;
  const town = [address.postalCode, address.addressLocality].filter(Boolean).join(' ');
  const parts = [address.streetAddress, town].map(cleanText).filter(Boolean);
  // A street without a town is no better than what the card said, so it takes both or neither.
  return address.addressLocality ? parts.join(', ') : null;
}

/**
 * The advert's own coordinates. Saves a geocoder lookup, and is the building rather than the centre
 * of a municipality.
 *
 * @param {any} product
 * @returns {{latitude: number, longitude: number}|{}}
 */
function readCoordinates(product) {
  const latitude = Number(product?.location?.geo?.latitude);
  const longitude = Number(product?.location?.geo?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) {
    return {};
  }
  return { latitude, longitude };
}

/**
 * The advert's fact table ("Stockwerk", "Baujahr", "HWB-Klasse", ...) as label → value.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {Record<string, string>}
 */
function readFacts($) {
  /** @type {Record<string, string>} */
  const facts = {};
  $('div.justify-between').each((_, row) => {
    const spans = $(row).children('span');
    if (spans.length !== 2) return;
    const label = cleanText($(spans[0]).text());
    const value = cleanText($(spans[1]).text());
    if (label && value && facts[label] == null) facts[label] = value;
  });
  return facts;
}

/**
 * The advertisement text, with its line breaks kept.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string|null}
 */
function readDescription($) {
  const node = $('.detail-desc').first();
  if (node.length === 0) return null;
  node.find('br').replaceWith('\n');
  const text = node
    .text()
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length === 0 ? null : text;
}

/**
 * Enrich a listing with what only the advert knows: the street, the coordinates, the full text, the
 * Baujahr and the HWB class.
 *
 * The HWB class is Austria's energy certificate grade, which runs A++ to G rather than Germany's A+
 * to H. The shared normaliser maps the letters both scales have and leaves A++ unknown rather than
 * inventing a German equivalent for it.
 *
 * @param {ParsedListing} listing
 * @returns {Promise<ParsedListing>} The enriched listing, or the untouched one on failure.
 */
async function fetchDetails(listing) {
  try {
    const response = await fetch(listing.link, { headers: HEADERS });
    if (!response.ok) {
      logger.warn(`Could not fetch immo.tt.com advert '${listing.link}': ${response.status}`);
      return listing;
    }

    const $ = cheerio.load(await response.text());
    const product = readProduct($);
    const facts = readFacts($);

    return {
      ...listing,
      address: readStreetAddress(product) ?? listing.address,
      description: readDescription($) ?? listing.description,
      buildYear: normalizeBuildYear(facts.Baujahr) ?? listing.buildYear ?? null,
      energyClass: normalizeEnergyClass(facts['HWB-Klasse']) ?? listing.energyClass ?? null,
      ...readCoordinates(product),
    };
  } catch (error) {
    logger.warn(`Could not fetch immo.tt.com advert for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * @param {ParsedListing} o
 * @param {string[]} appliedBlackList
 * @returns {boolean}
 */
function applyBlacklist(o, appliedBlackList) {
  const titleNotBlacklisted = !isOneOf(o.title, appliedBlackList);
  const descNotBlacklisted = !isOneOf(o.description, appliedBlackList);
  return titleNotBlacklisted && descNotBlacklisted;
}

/** @type {ProviderConfig} */
const config = {
  url: null,
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  // The cards are parsed in getListings, which also has to rewrite the sort and the page size.
  crawlContainer: null,
  crawlFields: {},
  sortByDateParam: SORT_BY_DATE_PARAM,
  // The site's own price fields, as its search form names them. `#f`/`#t` are from and to; the
  // `#v|...` twins next to them are a "Preis auf Anfrage" toggle, not a bound.
  priceRangeParams: {
    min: 'f[price#f|price_f@g]',
    max: 'f[price#t|price_t@g]',
  },
  getListings,
  normalize,
  fetchDetails,
  activityProbe: checkIfListingIsActive,
  priceTracking: {
    // The advert publishes a schema.org Offer with the figure its card shows. A price on request
    // publishes no Offer at all, which reads as null - the same as the card's "Preis auf Anfrage".
    extract: readJsonLdPrice,
  },
};

export const metaInformation = {
  countries: ['at'],
  name: 'immo.tt.com',
  baseUrl: BASE_URL,
  id: 'immoTt',
};

/**
 * Build a run-scoped provider configuration.
 *
 * @param {{url: string, enabled?: boolean}} sourceConfig
 * @param {string[]} [blacklist]
 * @returns {ProviderConfig}
 */
export const createConfig = (sourceConfig, blacklist = []) => ({
  ...config,
  enabled: sourceConfig.enabled,
  url: sourceConfig.url,
  filter: (listing) => applyBlacklist(listing, blacklist ?? []),
});

export { config };
