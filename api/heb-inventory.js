// H-E-B live inventory adapter prototype
// Mirrors the Target strategy: retailer web fulfillment data -> normalized store/item status.
// Important: never convert request/parser failures into OUT_OF_STOCK.

const HEB_GRAPHQL = 'https://www.heb.com/graphql';

function normalizeAvailability(value) {
  const raw = String(value || '').toUpperCase();
  if (raw.includes('OUT_OF_STOCK') || raw === 'UNAVAILABLE') return 'OOS';
  if (raw.includes('IN_STOCK') || raw === 'AVAILABLE') return 'IN_STOCK';
  return 'UNKNOWN';
}

export default async function handler(req, res) {
  const { storeId, categoryId = '490015' } = req.query || {};
  if (!storeId) return res.status(400).json({ ok: false, error: 'storeId is required' });

  const query = `query HEBInventory($storeId: Int!, $categoryId: String!) {
    browseCategory(categoryId: $categoryId, storeId: $storeId, shoppingContext: CURBSIDE_PICKUP, limit: 100) {
      records {
        id
        displayName
        bestAvailable
        SKUs { id productAvailability }
      }
      total
      hasMoreRecords
    }
  }`;

  try {
    const upstream = await fetch(HEB_GRAPHQL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': 'Mozilla/5.0 HEB-InStock-Command-Center/1.0'
      },
      body: JSON.stringify({ query, variables: { storeId: Number(storeId), categoryId } })
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return res.status(502).json({ ok: false, status: 'UNKNOWN', upstreamStatus: upstream.status, error: 'H-E-B upstream request failed' });
    }

    let payload;
    try { payload = JSON.parse(text); }
    catch { return res.status(502).json({ ok: false, status: 'UNKNOWN', error: 'H-E-B response was not valid JSON' }); }

    if (payload.errors || !payload.data?.browseCategory) {
      return res.status(502).json({ ok: false, status: 'UNKNOWN', error: 'H-E-B response shape changed or request requires additional session context', details: payload.errors || null });
    }

    const records = payload.data.browseCategory.records || [];
    const items = records.map(product => {
      const sku = product.SKUs?.[0] || {};
      return {
        productId: product.id,
        sku: sku.id || null,
        name: product.displayName,
        bestAvailable: product.bestAvailable ?? null,
        availabilityRaw: sku.productAvailability ?? null,
        status: normalizeAvailability(sku.productAvailability)
      };
    });

    return res.status(200).json({ ok: true, source: 'heb-web-graphql', storeId: Number(storeId), categoryId, count: items.length, items });
  } catch (error) {
    return res.status(502).json({ ok: false, status: 'UNKNOWN', error: error?.message || 'Inventory request failed' });
  }
}
