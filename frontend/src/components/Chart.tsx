import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  LineSeries,
  LineStyle,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { atr, bollinger, ema, macd, rsi, sma, vwap, type IndicatorConfig, type Series } from '../lib/indicators';
import { price as fmtPrice } from '../lib/format';
import type { Candle } from '../lib/types';

// lightweight-charts renders timestamps as UTC; shifting by +05:30 shows IST on the axis.
const IST_S = 330 * 60;
export const toChartTime = (ms: number) => (Math.floor(ms / 1000) + IST_S) as UTCTimestamp;
export const fromChartTime = (t: Time) => ((t as number) - IST_S) * 1000;
const R = (p: number) => p / 100;

export type LineKind = 'entry' | 'sl' | 'tp';
export interface OrderLines {
  entry?: number | null;
  sl?: number | null;
  tp?: number | null;
  draggable?: LineKind[];
}
export interface StaticLine {
  price: number;
  title: string;
  color: string;
  style?: 'solid' | 'dashed' | 'dotted';
}
export interface Drawing {
  id: number;
  kind: 'hline' | 'trend';
  data: { price?: number; p1?: { time: number; price: number }; p2?: { time: number; price: number } };
}

interface Props {
  candles: Candle[];
  /** In-progress bar (from live ticks / replay), merged on top of `candles`. */
  liveBar?: Candle | null;
  indicators: IndicatorConfig;
  dark: boolean;
  orderLines?: OrderLines;
  onDragLine?: (kind: LineKind, pricePaise: number) => void;
  staticLines?: StaticLine[];
  drawings?: Drawing[];
  drawMode?: 'none' | 'hline' | 'trend';
  onDraw?: (d: Omit<Drawing, 'id'>) => void;
  height?: number;
  /** Show all candles instead of zooming to the most recent ones. */
  fitAll?: boolean;
  markers?: Array<{ time: number; position: 'aboveBar' | 'belowBar'; color: string; text: string; shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square' }>;
}

function palette(dark: boolean) {
  return dark
    ? { bg: '#151c28', text: '#9aa5b8', grid: '#1e2737', border: '#253043', up: '#4ade80', down: '#f87171', volUp: 'rgba(74,222,128,0.35)', volDown: 'rgba(248,113,113,0.35)', accent: '#2dd4bf' }
    : { bg: '#ffffff', text: '#5b6474', grid: '#eef0f4', border: '#dde1e8', up: '#15803d', down: '#c62828', volUp: 'rgba(21,128,61,0.35)', volDown: 'rgba(198,40,40,0.35)', accent: '#0f766e' };
}

const lineData = (candles: Candle[], s: Series) =>
  candles.flatMap((c, i) => (s[i] === null || s[i] === undefined ? [] : [{ time: toChartTime(c.openTime), value: R(s[i]!) }]));

const LINE_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted };

export function PriceChart(props: Props) {
  const { candles, liveBar, indicators, dark } = props;
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const extra = useRef<ISeriesApi<any>[]>([]);
  const trendSeries = useRef<ISeriesApi<'Line'>[]>([]);
  const priceLines = useRef<IPriceLine[]>([]);
  const orderPriceLines = useRef<Partial<Record<LineKind, IPriceLine>>>({});
  const markersApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const dragging = useRef<LineKind | null>(null);
  const pendingTrend = useRef<{ time: number; price: number } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [readout, setReadout] = useState<Candle | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const colors = palette(dark);

  const merged = useMemo(() => {
    if (!liveBar) return candles;
    const last = candles[candles.length - 1];
    if (last && last.openTime === liveBar.openTime) return [...candles.slice(0, -1), liveBar];
    if (!last || liveBar.openTime > last.openTime) return [...candles, liveBar];
    return candles;
  }, [candles, liveBar]);

  // Create the chart once.
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: colors.bg }, textColor: colors.text, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      localization: { priceFormatter: (p: number) => p.toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
    });
    chart.current = c;
    main.current = c.addSeries(CandlestickSeries, { upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down, borderVisible: false, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
    volume.current = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
    markersApi.current = createSeriesMarkers(main.current, []);

    const onMove = (p: MouseEventParams<Time>) => {
      if (!p.time || !main.current) return setReadout(null);
      const bar = p.seriesData.get(main.current) as any;
      const vol = volume.current ? (p.seriesData.get(volume.current) as any) : null;
      if (bar) setReadout({ openTime: fromChartTime(p.time), o: bar.open * 100, h: bar.high * 100, l: bar.low * 100, c: bar.close * 100, volume: vol?.value ?? 0, oi: null });
    };
    c.subscribeCrosshairMove(onMove);
    const onClick = (p: MouseEventParams<Time>) => {
      const { drawMode, onDraw } = propsRef.current;
      if (!drawMode || drawMode === 'none' || !p.point || !main.current || !onDraw) return;
      const price = main.current.coordinateToPrice(p.point.y);
      if (price === null) return;
      const paise = Math.round(price * 100);
      if (drawMode === 'hline') {
        onDraw({ kind: 'hline', data: { price: paise } });
        return;
      }
      const t = p.time ? fromChartTime(p.time) : null;
      if (t === null) return;
      if (!pendingTrend.current) {
        pendingTrend.current = { time: t, price: paise };
        setHint('Tap the second point of the trend line');
      } else {
        const p1 = pendingTrend.current;
        pendingTrend.current = null;
        setHint(null);
        if (p1.time !== t) onDraw({ kind: 'trend', data: { p1, p2: { time: t, price: paise } } });
      }
    };
    c.subscribeClick(onClick);
    return () => {
      c.unsubscribeCrosshairMove(onMove);
      c.unsubscribeClick(onClick);
      c.remove();
      chart.current = null;
      main.current = null;
      volume.current = null;
      extra.current = [];
      trendSeries.current = [];
      priceLines.current = [];
      orderPriceLines.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme.
  useEffect(() => {
    chart.current?.applyOptions({
      layout: { background: { color: colors.bg }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border },
    });
    main.current?.applyOptions({ upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down });
  }, [dark]); // eslint-disable-line react-hooks/exhaustive-deps

  // Price data + indicators. Indicator series are rebuilt when the config or the candle set changes.
  const firstTime = merged[0]?.openTime;
  const firstTimeRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const c = chart.current;
    if (!c || !main.current || !volume.current) return;
    main.current.setData(merged.map((k) => ({ time: toChartTime(k.openTime), open: R(k.o), high: R(k.h), low: R(k.l), close: R(k.c) })));
    volume.current.setData(merged.map((k) => ({ time: toChartTime(k.openTime), value: k.volume, color: k.c >= k.o ? colors.volUp : colors.volDown })));

    for (const s of extra.current) c.removeSeries(s);
    extra.current = [];
    const closes = merged.map((k) => k.c);
    const add = (opts: Record<string, unknown>, data: Array<{ time: UTCTimestamp; value: number }>, pane = 0, kind: 'line' | 'hist' = 'line') => {
      const s = kind === 'line' ? c.addSeries(LineSeries, { lineWidth: 1.5 as any, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts }, pane) : c.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, ...opts }, pane);
      s.setData(data as any);
      extra.current.push(s);
      return s;
    };
    if (indicators.sma.on) add({ color: '#f59e0b', title: `SMA ${indicators.sma.period}` }, lineData(merged, sma(closes, indicators.sma.period)));
    if (indicators.ema.on) add({ color: '#3b82f6', title: `EMA ${indicators.ema.period}` }, lineData(merged, ema(closes, indicators.ema.period)));
    if (indicators.vwap.on) add({ color: '#a855f7', lineStyle: LineStyle.Dashed, title: 'VWAP' }, lineData(merged, vwap(merged)));
    if (indicators.bb.on) {
      const b = bollinger(closes, indicators.bb.period, indicators.bb.mult);
      add({ color: 'rgba(100,116,139,0.9)', lineWidth: 1 }, lineData(merged, b.upper));
      add({ color: 'rgba(100,116,139,0.6)', lineStyle: LineStyle.Dotted, lineWidth: 1 }, lineData(merged, b.mid));
      add({ color: 'rgba(100,116,139,0.9)', lineWidth: 1 }, lineData(merged, b.lower));
    }
    if (indicators.volMa.on) add({ color: '#94a3b8', lineWidth: 1, priceFormat: { type: 'volume' } }, lineData(merged, sma(merged.map((x) => x.volume), indicators.volMa.period)).map((d) => ({ ...d, value: d.value * 100 })), 1);
    let pane = 2;
    if (indicators.rsi.on) {
      const s = add({ color: '#8b5cf6', title: `RSI ${indicators.rsi.period}`, lastValueVisible: true }, rsi(closes, indicators.rsi.period).flatMap((v, i) => (v === null ? [] : [{ time: toChartTime(merged[i].openTime), value: v }])), pane++);
      s.createPriceLine({ price: 70, color: '#94a3b8', lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: '' });
      s.createPriceLine({ price: 30, color: '#94a3b8', lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: '' });
    }
    if (indicators.macd.on) {
      const m = macd(closes, indicators.macd.fast, indicators.macd.slow, indicators.macd.signal);
      add({ color: '#94a3b8' }, m.hist.flatMap((v, i) => (v === null ? [] : [{ time: toChartTime(merged[i].openTime), value: R(v), color: v >= 0 ? colors.volUp : colors.volDown } as any])), pane, 'hist');
      add({ color: '#3b82f6', title: 'MACD' }, lineData(merged, m.line), pane);
      add({ color: '#f97316', title: 'Signal' }, lineData(merged, m.signal), pane++);
    }
    if (indicators.atr.on) add({ color: '#0ea5e9', title: `ATR ${indicators.atr.period}`, lastValueVisible: true }, lineData(merged, atr(merged, indicators.atr.period)), pane++);
    if (indicators.oi.on) add({ color: '#eab308', title: 'Open interest', lastValueVisible: true, priceFormat: { type: 'volume' } }, merged.flatMap((k) => (k.oi === null || k.oi === undefined ? [] : [{ time: toChartTime(k.openTime), value: k.oi }])), pane++);

    // Pane heights: main chart large, sub-panes compact.
    const panes = c.panes();
    const total = el.current?.clientHeight ?? 400;
    const subCount = Math.max(0, panes.length - 2);
    const volH = Math.round(total * 0.14);
    const subH = Math.round(total * 0.16);
    panes.forEach((p, i) => {
      if (i === 1) p.setHeight(volH);
      else if (i >= 2) p.setHeight(subH);
    });
    if (panes[0]) panes[0].setHeight(Math.max(140, total - volH - subCount * subH));

    // Rollover stitch markers.
    markersApi.current?.setMarkers([
      ...merged.filter((k) => k.stitch).map((k) => ({ time: toChartTime(k.openTime), position: 'aboveBar' as const, color: '#94a3b8', shape: 'square' as const, text: `Rollover → ${k.contract ?? ''}` })),
      ...(props.markers ?? []).map((m) => ({ ...m, time: toChartTime(m.time) })),
    ]);
    if (firstTimeRef.current !== firstTime) {
      firstTimeRef.current = firstTime;
      c.timeScale().fitContent();
      if (merged.length > 150 && !props.fitAll) c.timeScale().setVisibleLogicalRange({ from: merged.length - 120, to: merged.length + 4 });
    }
  }, [merged, indicators, dark, props.markers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Static lines (positions, previous day levels, pivots) and horizontal drawings.
  useEffect(() => {
    const s = main.current;
    if (!s) return;
    for (const l of priceLines.current) s.removePriceLine(l);
    priceLines.current = [];
    for (const l of props.staticLines ?? []) {
      priceLines.current.push(s.createPriceLine({ price: R(l.price), color: l.color, lineWidth: 1, lineStyle: LINE_STYLE[l.style ?? 'dashed'], axisLabelVisible: true, title: l.title }));
    }
    for (const d of props.drawings ?? []) {
      if (d.kind === 'hline' && d.data.price) {
        priceLines.current.push(s.createPriceLine({ price: R(d.data.price), color: '#f59e0b', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '' }));
      }
    }
  }, [props.staticLines, props.drawings, merged.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trend lines are two-point line series.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    for (const s of trendSeries.current) c.removeSeries(s);
    trendSeries.current = [];
    for (const d of props.drawings ?? []) {
      if (d.kind !== 'trend' || !d.data.p1 || !d.data.p2) continue;
      const [a, b] = [d.data.p1, d.data.p2].sort((x, y) => x.time - y.time);
      if (a.time === b.time) continue;
      const s = c.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData([
        { time: toChartTime(a.time), value: R(a.price) },
        { time: toChartTime(b.time), value: R(b.price) },
      ]);
      trendSeries.current.push(s);
    }
  }, [props.drawings, merged.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Entry / stop-loss / target lines of the order being prepared.
  useEffect(() => {
    const s = main.current;
    if (!s) return;
    const want: Record<LineKind, { color: string; title: string }> = {
      entry: { color: colors.accent, title: 'Entry' },
      sl: { color: colors.down, title: 'Stop' },
      tp: { color: colors.up, title: 'Target' },
    };
    for (const kind of Object.keys(want) as LineKind[]) {
      const p = props.orderLines?.[kind];
      const existing = orderPriceLines.current[kind];
      if (!p) {
        if (existing) s.removePriceLine(existing);
        delete orderPriceLines.current[kind];
        continue;
      }
      const draggable = props.orderLines?.draggable?.includes(kind);
      const opts = { price: R(p), color: want[kind].color, lineWidth: 2 as const, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `${want[kind].title}${draggable ? ' ⇕' : ''}` };
      if (existing) existing.applyOptions(opts);
      else orderPriceLines.current[kind] = s.createPriceLine(opts);
    }
  }, [props.orderLines, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag order lines with mouse or finger.
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const hit = (y: number): LineKind | null => {
      const { orderLines } = propsRef.current;
      if (!orderLines?.draggable || !main.current) return null;
      for (const kind of orderLines.draggable) {
        const p = orderLines[kind];
        if (!p) continue;
        const coord = main.current.priceToCoordinate(R(p));
        if (coord !== null && Math.abs(coord - y) < 14) return kind;
      }
      return null;
    };
    const yOf = (e: PointerEvent) => e.clientY - node.getBoundingClientRect().top;
    const down = (e: PointerEvent) => {
      const kind = hit(yOf(e));
      if (!kind) return;
      dragging.current = kind;
      node.setPointerCapture(e.pointerId);
      chart.current?.applyOptions({ handleScroll: false, handleScale: false });
      e.preventDefault();
      e.stopPropagation();
    };
    const move = (e: PointerEvent) => {
      const y = yOf(e);
      if (!dragging.current) {
        node.style.cursor = hit(y) ? 'ns-resize' : '';
        return;
      }
      const price = main.current?.coordinateToPrice(y);
      if (price !== null && price !== undefined && price > 0) propsRef.current.onDragLine?.(dragging.current, Math.round(price * 100));
    };
    const up = (e: PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        node.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      chart.current?.applyOptions({ handleScroll: true, handleScale: true });
    };
    node.addEventListener('pointerdown', down, { capture: true });
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    return () => {
      node.removeEventListener('pointerdown', down, { capture: true });
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
    };
  }, []);

  useEffect(() => {
    if (props.drawMode !== 'trend') {
      pendingTrend.current = null;
      setHint(null);
    } else setHint('Tap the first point of the trend line');
    if (props.drawMode === 'hline') setHint('Tap the chart to place a horizontal line');
  }, [props.drawMode]);

  const r = readout ?? merged[merged.length - 1] ?? null;
  return (
    <div className="chart-wrap" style={{ height: props.height ?? 380 }}>
      {r && (
        <div className="chart-readout tiny num">
          <span>O <b>{fmtPrice(r.o)}</b></span>
          <span>H <b>{fmtPrice(r.h)}</b></span>
          <span>L <b>{fmtPrice(r.l)}</b></span>
          <span>C <b className={r.c >= r.o ? 'profit' : 'loss'}>{fmtPrice(r.c)}</b></span>
          <span>Vol <b>{Math.round(r.volume).toLocaleString('en-IN')}</b></span>
        </div>
      )}
      {hint && <div className="chart-hint small">{hint}</div>}
      <div ref={el} className="chart-canvas" style={{ touchAction: props.drawMode && props.drawMode !== 'none' ? 'none' : 'pan-y' }} />
    </div>
  );
}
