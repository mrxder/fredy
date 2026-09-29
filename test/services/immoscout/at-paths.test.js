/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  AT_COUNTRY_GEOCODE,
  ambiguousAlternativesFor,
  COMMERCIAL_SLUGS,
  listKnownAtPaths,
  mergeAtParams,
  resolveAtPath,
  resolveAtPathFilters,
  splitAtPath,
  toGeocode,
  translateAtQueryParams,
} from '../../../lib/services/immoscout/at-paths.js';
import logger from '../../../lib/services/logger.js';

/** Path segments as `URL#pathname.split('/')` hands them over, leading empty string and all. */
const segmentsOf = (pathname) => pathname.split('/');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#at-paths splitAtPath()', () => {
  it('splits an area and a type slug', () => {
    expect(splitAtPath(segmentsOf('/regional/wien/wien/wohnung-mieten'))).toEqual({
      area: ['wien', 'wien'],
      slug: 'wohnung-mieten',
      filters: [],
    });
  });

  it('reads a country wide search, which names no Bundesland', () => {
    expect(splitAtPath(segmentsOf('/regional/oesterreich/haus-kaufen'))).toEqual({
      area: ['oesterreich'],
      slug: 'haus-kaufen',
      filters: [],
    });
  });

  // The site writes paging and sorting into the path, after the type slug. Reading the slug off the
  // end without taking them off first resolved `seite-2` as a real estate type and refused the URL.
  it('strips the paging modifier off the end', () => {
    expect(splitAtPath(segmentsOf('/regional/wien/wien/wohnung-mieten/seite-3'))).toEqual({
      area: ['wien', 'wien'],
      slug: 'wohnung-mieten',
      filters: [],
    });
  });

  it('strips the sorting modifier off the end', () => {
    expect(splitAtPath(segmentsOf('/regional/wien/wien/wohnung-kaufen/aktualitaet'))).toEqual({
      area: ['wien', 'wien'],
      slug: 'wohnung-kaufen',
      filters: [],
    });
  });

  it('strips several modifiers at once', () => {
    expect(splitAtPath(segmentsOf('/regional/wien/wien/wohnung-mieten/aktualitaet/seite-2')).slug).toBe(
      'wohnung-mieten',
    );
  });

  it('reports no slug when the path names nothing but an area', () => {
    expect(splitAtPath(segmentsOf('/regional/wien')).slug).toBeNull();
  });

  // Reported from the field: `parkplatz` was read as the type slug and the URL refused.
  it('takes the feature filters after the type slug off separately', () => {
    expect(splitAtPath(segmentsOf('/regional/tirol/innsbruck/immobilien/parkplatz/keller/seite-2'))).toEqual({
      area: ['tirol', 'innsbruck'],
      slug: 'immobilien',
      filters: ['parkplatz', 'keller'],
    });
  });

  it('only reads feature filters from after the type slug', () => {
    expect(splitAtPath(segmentsOf('/regional/wien/wien/neubau/wohnung-mieten'))).toEqual({
      area: ['wien', 'wien', 'neubau'],
      slug: 'wohnung-mieten',
      filters: [],
    });
  });
});

describe('#at-paths resolveAtPathFilters()', () => {
  it('stacks equipment filters rather than replacing one with the next', () => {
    expect(resolveAtPathFilters(['parkplatz', 'keller', 'aufzug'])).toEqual({
      equipment: ['parking', 'cellar', 'lift'],
    });
  });

  it('translates the filters that are not equipment', () => {
    expect(resolveAtPathFilters(['neubau', 'provisionsfrei'])).toEqual({
      newbuilding: true,
      freeofcourtageonly: true,
    });
  });

  // The API reads `fulltext=altbau pool` as both words, so two full text filters narrow together.
  it('joins full text filters into one search', () => {
    expect(resolveAtPathFilters(['altbau', 'pool'])).toEqual({ fulltext: 'altbau pool' });
  });

  it('drops a filter the API cannot express and says so', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(resolveAtPathFilters(['parkplatz', 'moebliert'])).toEqual({ equipment: ['parking'] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('moebliert'));
  });
});

describe('#at-paths mergeAtParams()', () => {
  it('lets the later value win for a plain parameter', () => {
    expect(mergeAtParams({ newbuilding: true, price: '-100.0' }, { price: '-200.0' })).toEqual({
      newbuilding: true,
      price: '-200.0',
    });
  });

  it('accumulates equipment without duplicates', () => {
    expect(mergeAtParams({ equipment: ['parking'] }, { equipment: ['parking', 'garden'] })).toEqual({
      equipment: ['parking', 'garden'],
    });
  });
});

describe('#at-paths toGeocode()', () => {
  it('prefixes the area with the country the mobile API files it under', () => {
    expect(toGeocode(['wien', 'wien'])).toBe('/at/wien/wien');
    expect(toGeocode(['steiermark', 'graz'])).toBe('/at/steiermark/graz');
  });

  // The site says `oesterreich` where the API says `/at`, and answers 412 for `/at/oesterreich`.
  it('rewrites the site word for the whole country to the API code', () => {
    expect(toGeocode(['oesterreich'])).toBe(AT_COUNTRY_GEOCODE);
    expect(toGeocode([])).toBe(AT_COUNTRY_GEOCODE);
  });

  // Every spelling of a Viennese district answers 412 - the Austrian half of the index has two
  // geocode levels where the German half has three. Widening finds the flat; a 412 finds nothing
  // and reads exactly like a search that came up empty.
  it('widens a district to its municipality and says so', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(toGeocode(['wien', 'wien', '1-bezirk-innere-stadt'])).toBe('/at/wien/wien');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1-bezirk-innere-stadt'));
  });

  it('does not warn for an area the API can take as it is', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    toGeocode(['wien', 'wien']);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('#at-paths resolveAtPath()', () => {
  it('resolves the four single-deal base paths', () => {
    expect(resolveAtPath('wohnung-mieten').realType).toBe('apartmentrent');
    expect(resolveAtPath('wohnung-kaufen').realType).toBe('apartmentbuy');
    expect(resolveAtPath('haus-mieten').realType).toBe('houserent');
    expect(resolveAtPath('haus-kaufen').realType).toBe('housebuy');
  });

  // `immobilien` is the one multi-type search the API runs correctly: four types spanning both
  // deals sum, where a rent/buy pair of one category silently answers with the first of the two.
  it('resolves the all-property path to the four living types', () => {
    expect(resolveAtPath('immobilien').realType).toEqual(['apartmentrent', 'apartmentbuy', 'houserent', 'housebuy']);
  });

  it('carries a path-only filter along with its type', () => {
    expect(resolveAtPath('wohnung-mit-garage-mieten')).toEqual({
      realType: 'apartmentrent',
      params: { equipment: ['parking'] },
    });
  });

  describe('generated paths', () => {
    it('reads an exact room count as the half-step range the API wants', () => {
      expect(resolveAtPath('3-zimmer-wohnung-mieten')).toEqual({
        realType: 'apartmentrent',
        params: { numberofrooms: '3.0-3.5' },
      });
    });

    it('reads a minimum room count as an open ended range', () => {
      expect(resolveAtPath('wohnung-ab-4-zimmer-mieten').params).toEqual({ numberofrooms: '4.0-' });
    });

    // The site states a gross rent on these pages, which is the API's `calculatedtotalrent` - and
    // that price type exists for apartment rentals alone, hence the asymmetry with `-kaufen`.
    it('reads a maximum rent as a total rent', () => {
      expect(resolveAtPath('wohnung-bis-1100-euro-mieten')).toEqual({
        realType: 'apartmentrent',
        params: { price: '-1100.0', pricetype: 'calculatedtotalrent' },
      });
    });

    it('reads a maximum purchase price without a price type', () => {
      expect(resolveAtPath('wohnung-bis-300000-euro-kaufen')).toEqual({
        realType: 'apartmentbuy',
        params: { price: '-300000.0' },
      });
    });

    it('reads living space bounds from both directions', () => {
      expect(resolveAtPath('wohnung-bis-70-m2-mieten').params).toEqual({ livingspace: '-70.0' });
      expect(resolveAtPath('wohnung-ab-100-m2-mieten').params).toEqual({ livingspace: '100.0-' });
    });
  });

  it('does not resolve a path the table has never seen', () => {
    expect(resolveAtPath('almhuette-kaufen')).toBeNull();
  });

  // Every registered path has to carry a type, or the assembled URL would name none and the API
  // would answer 412 for a search the translator reported as understood.
  it('gives every catalogued path a real estate type', () => {
    for (const slug of listKnownAtPaths()) {
      const resolved = resolveAtPath(slug);
      expect(resolved, slug).not.toBeNull();
      expect(resolved.realType, slug).toBeTruthy();
    }
  });
});

describe('#at-paths ambiguousAlternativesFor()', () => {
  it('names both single-deal slugs for a plural one', () => {
    expect(ambiguousAlternativesFor('wohnungen')).toEqual(['wohnung-mieten', 'wohnung-kaufen']);
  });

  it('builds the alternatives of a generated plural slug from its own numbers', () => {
    expect(ambiguousAlternativesFor('3-zimmer-wohnungen')).toEqual([
      '3-zimmer-wohnung-mieten',
      '3-zimmer-wohnung-kaufen',
    ]);
    expect(ambiguousAlternativesFor('wohnungen-bis-70-m2')).toEqual([
      'wohnung-bis-70-m2-mieten',
      'wohnung-bis-70-m2-kaufen',
    ]);
  });

  it('stays quiet about a slug that is not ambiguous', () => {
    expect(ambiguousAlternativesFor('wohnung-mieten')).toBeNull();
  });

  // A slug cannot be both refused as ambiguous and resolved as a search, or which of the two
  // happens would come down to the order the translator asks its questions in.
  it('never marks a resolvable path as ambiguous', () => {
    for (const slug of listKnownAtPaths()) {
      expect(ambiguousAlternativesFor(slug), slug).toBeNull();
      expect(COMMERCIAL_SLUGS.has(slug), slug).toBe(false);
    }
  });

  // Every alternative offered has to be a search the translator can actually run, or the error
  // message sends the user to a URL that is refused in turn.
  it('only offers alternatives that resolve', () => {
    for (const slug of Object.keys({ wohnungen: 1, '3-zimmer-wohnungen': 1, 'wohnungen-ab-100-m2': 1 })) {
      for (const alternative of ambiguousAlternativesFor(slug)) {
        expect(resolveAtPath(alternative), `${slug} -> ${alternative}`).not.toBeNull();
      }
    }
  });
});

describe('#at-paths translateAtQueryParams()', () => {
  it('assembles the two halves of a range into one parameter', () => {
    expect(translateAtQueryParams({ primaryPriceFrom: '500', primaryPriceTo: '1200' })).toEqual({
      price: '500.0-1200.0',
    });
  });

  // An absent bound is an empty half, which is the shape ImmoScout's own pages emit - not a bound
  // of zero, which would be a different search.
  it('leaves an absent bound empty', () => {
    expect(translateAtQueryParams({ primaryPriceTo: '1200' })).toEqual({ price: '-1200.0' });
    expect(translateAtQueryParams({ primaryAreaFrom: '80' })).toEqual({ livingspace: '80.0-' });
  });

  it('translates every range the site states', () => {
    expect(translateAtQueryParams({ numberOfRoomsFrom: '2', numberOfRoomsTo: '4' })).toEqual({
      numberofrooms: '2.0-4.0',
    });
  });

  it('ignores the site paging and sorting without a word', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(translateAtQueryParams({ page: '2', sort: 'newest', utm_source: 'newsletter' })).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips an empty value rather than turning it into a bound', () => {
    expect(translateAtQueryParams({ primaryPriceTo: '' })).toEqual({});
  });

  // `abc` became `-NaN`, which the API refuses, and `0` a price cap of nothing.
  it('drops a bound that is not a positive number', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(translateAtQueryParams({ primaryPriceTo: 'abc', primaryAreaFrom: '0' })).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('primaryPriceTo'));
  });

  describe('outdoor spaces', () => {
    it('collapses balcony, terrace and loggia onto the one flag the API has', () => {
      expect(translateAtQueryParams({ outdoorSpaces: ['GARDEN', 'TERRACE', 'BALCONY', 'LOGGIA'] })).toEqual({
        equipment: ['garden', 'balcony'],
      });
    });

    it('reads a comma separated value the same as a split one', () => {
      expect(translateAtQueryParams({ outdoorSpaces: 'BALCONY,GARDEN' })).toEqual({ equipment: ['balcony', 'garden'] });
    });

    it('stays quiet when the search is exactly as wide as asked for', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      translateAtQueryParams({ outdoorSpaces: 'GARDEN' });
      translateAtQueryParams({ outdoorSpaces: ['BALCONY', 'TERRACE', 'LOGGIA'] });
      expect(warn).not.toHaveBeenCalled();
    });

    // A terrace alone comes back as balcony, terrace or loggia - wider, and said so.
    it('says so when it has to widen a part of the balcony group', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      expect(translateAtQueryParams({ outdoorSpaces: 'TERRACE' })).toEqual({ equipment: ['balcony'] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('outdoorSpaces=TERRACE'));
    });

    it('reports a value it does not know and keeps the rest', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      expect(translateAtQueryParams({ outdoorSpaces: ['ROOFTOP', 'GARDEN'] })).toEqual({ equipment: ['garden'] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ROOFTOP'));
    });

    it('sends nothing when no value was usable', () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});

      expect(translateAtQueryParams({ outdoorSpaces: 'ROOFTOP' })).toEqual({});
    });
  });

  // A filter the user set and did not get is worth a log line, the same trade the German side's
  // `keepSupported` makes. Silence here would hand back a wider search with no trace of why.
  it('reports a filter it cannot translate', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(translateAtQueryParams({ isSocialHousing: 'true' })).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('isSocialHousing'));
  });
});
