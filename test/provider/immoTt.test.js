/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import * as provider from '../../lib/provider/immoTt.js';

/**
 * immo.tt.com, the Tiroler Tageszeitung's property marketplace.
 *
 * The pipeline run below is structural rather than literal, because the same file runs against the
 * fixture (`yarn test:offline`) and against the live portal (`yarn test`), where every advert
 * differs. The unit tests after it pin the parts that do not depend on what is listed today.
 */
const TEST_TIMEOUT = 120_000;

const fixture = (name) => readFileSync(new URL(`../testFixtures/${name}`, import.meta.url), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#immoTt provider testsuite()', () => {
  /** @type {any[]} */
  let listings;

  beforeAll(async () => {
    const Fredy = await mockFredy();
    const runConfig = provider.createConfig(providerConfig.immoTt, []);
    const job = { id: 'immoTt', notificationAdapter: null, spatialFilter: null, specFilter: null };

    const fredy = new Fredy(runConfig, job, provider.metaInformation.id, similarityCache, undefined);
    listings = await fredy.execute();
  }, TEST_TIMEOUT);

  it('finds listings', () => {
    expect(listings).toBeInstanceOf(Array);
    expect(listings.length).toBeGreaterThan(0);
  });

  it('links every listing to its advert', () => {
    for (const listing of listings) {
      expect(listing.link, `link of ${listing.id}`).toMatch(/^https:\/\/immo\.tt\.com\/immobilien\//);
      expect(listing.title, `title of ${listing.id}`).toBeTruthy();
    }
  });

  it('reads the headline figures as numbers', () => {
    for (const listing of listings) {
      // "Preis auf Anfrage" is common here, and a parking space has no rooms, so each figure is
      // checked for being sane when there is one.
      if (listing.price != null) expect(listing.price, `price of ${listing.id}`).toBeGreaterThan(0);
      if (listing.size != null) expect(listing.size, `size of ${listing.id}`).toBeGreaterThan(0);
      if (listing.rooms != null) {
        expect(listing.rooms, `rooms of ${listing.id}`).toBeGreaterThan(0);
        expect(listing.rooms, `rooms of ${listing.id}`).toBeLessThan(30);
      }
    }
    // A run where nothing at all carries a figure is the parsing breaking, not every advertiser
    // going quiet on the same day.
    expect(listings.some((listing) => listing.price != null)).toBe(true);
    expect(listings.some((listing) => listing.size != null)).toBe(true);
    expect(listings.some((listing) => listing.rooms != null)).toBe(true);
  });

  // The card names the municipality alone. The state is what keeps the geocoder in Tyrol.
  it('gives every listing an address with its Bundesland', () => {
    for (const listing of listings) {
      expect(listing.address, `address of ${listing.id}`).toMatch(/, Tirol$/);
    }
  });

  it('declares Austria, which is what sends the geocoder there', () => {
    expect(provider.metaInformation.countries).toEqual(['at']);
  });
});

describe('#immoTt search url', () => {
  it('sorts newest first and asks for a larger page', () => {
    const url = new URL(provider.buildSearchUrl(providerConfig.immoTt.url));

    expect(url.searchParams.get('s[displays_at]')).toBe('desc');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('f[price#t|price_t@g]')).toBe('450000');
  });

  // The site applies its sort keys in order, so a URL copied while sorted by price kept the price
  // sort ahead of the date sort.
  it('drops the sort, page and limit the copied URL carried', () => {
    const url = new URL(
      provider.buildSearchUrl(
        'https://immo.tt.com/kaufobjekt/wohnung/tirol?f%5Bliving%40f%5D=50&s%5Bprice%5D=asc&s%5Bgt%28price%2C+0%29%5D=desc&page=3&limit=10',
      ),
    );

    expect([...url.searchParams.keys()].filter((key) => key.startsWith('s['))).toEqual(['s[displays_at]']);
    expect(url.searchParams.get('page')).toBeNull();
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('f[living@f]')).toBe('50');
  });
});

describe('#immoTt normalize()', () => {
  const { normalize } = provider.createConfig(providerConfig.immoTt, []);
  const card = {
    id: '369587',
    link: '/immobilien/wohnung/wohnung/tirol/innsbruck-stadt/GNBunrMYyZt',
    title: 'Altbau in Wilten',
    location: 'Hötting',
    size: '90 m²',
    rooms: '3 Zimmer',
  };

  it('reads a price that puts the currency first', () => {
    expect(normalize({ ...card, price: '€ 450.000' }).price).toBe(450000);
    expect(normalize({ ...card, price: '€ 1.799,3' }).price).toBe(1799.3);
  });

  it('reads a price on request as unknown rather than as zero', () => {
    expect(normalize({ ...card, price: 'Preis auf Anfrage' }).price).toBeNull();
  });

  it('reads a room count the card leaves as a dash as unknown', () => {
    expect(normalize({ ...card, rooms: null, price: '€ 110' }).rooms).toBeNull();
  });

  it('makes the link absolute and names the state from it', () => {
    const listing = normalize({ ...card, price: '€ 450.000' });
    expect(listing.link).toBe('https://immo.tt.com/immobilien/wohnung/wohnung/tirol/innsbruck-stadt/GNBunrMYyZt');
    expect(listing.address).toBe('Hötting, Tirol');
  });

  it('keeps the advert id stable while the price stays the same', () => {
    expect(normalize({ ...card, price: '€ 450.000' }).id).toBe(normalize({ ...card, price: '€ 450.000' }).id);
    expect(normalize({ ...card, price: '€ 450.000' }).id).not.toBe(normalize({ ...card, price: '€ 440.000' }).id);
  });
});

/**
 * The advert fixture is the one the download tool recorded for the first card of the search, so
 * these read real markup. They assert shape rather than the figures, which change with the advert.
 */
describe('#immoTt fetchDetails()', () => {
  const html = fixture('immoTt_detail.html');
  const listing = {
    id: 'x',
    link: 'https://immo.tt.com/immobilien/wohnung/wohnung/tirol/innsbruck-stadt/GNBunrMYyZt',
    title: 'Altbau in Wilten',
    address: 'Innsbruck, Tirol',
    description: null,
  };

  it('adds the street, the full text and the coordinates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));

    const enriched = await provider.config.fetchDetails(listing);

    expect(enriched.address).toMatch(/^.+, \d{4} .+$/);
    expect(enriched.description?.length).toBeGreaterThan(100);
    // Tyrol, give or take its borders.
    expect(enriched.latitude).toBeGreaterThan(46.5);
    expect(enriched.latitude).toBeLessThan(47.8);
    expect(enriched.longitude).toBeGreaterThan(10);
    expect(enriched.longitude).toBeLessThan(13);
  });

  it('keeps the listing as it was when the advert cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }));

    expect(await provider.config.fetchDetails(listing)).toEqual(listing);
  });

  it('reads the price the advert publishes for the price history', () => {
    const price = provider.config.priceTracking.extract(html, { id: 'x', link: listing.link, provider: 'immoTt' });
    expect(price === null || price > 0).toBe(true);
  });
});
