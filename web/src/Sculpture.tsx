import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { Button, useText } from './ui';

// Decorative folded ribbon. Deterministic geometry, never presented as telemetry.
export default function Sculpture() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [paused, setPaused] = useState(false);
  const { t } = useText();
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = navigator as Navigator & { connection?: { saveData?: boolean } };
    let visible = true;
    let frame = 0;
    let disposed = false;
    let pointer: { x: number; y: number; active: boolean } = { x: -1000, y: -1000, active: false };
    const vertices = [[0.22, 0.85], [0.22, 0.18], [0.65, 0.18], [0.78, 0.39], [0.43, 0.60], [0.78, 0.85]];
    const dots = vertices.slice(1).flatMap((to, i) => {
      const from = vertices[i];
      return Array.from({ length: 170 }, (_, n) => {
        const along = (n % 34) / 33; const width = Math.floor(n / 34) - 2;
        return { x: from[0] + (to[0] - from[0]) * along + width * 0.013, y: from[1] + (to[1] - from[1]) * along - width * 0.012, i: n + i * 170, width };
      });
    });
    function draw(time = 0) {
      if (!element || !context || disposed) return;
      const bounds = element.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, bounds.width < 480 ? 1.25 : 1.5);
      if (element.width !== Math.round(bounds.width * dpr) || element.height !== Math.round(bounds.height * dpr)) { element.width = Math.round(bounds.width * dpr); element.height = Math.round(bounds.height * dpr); }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      const accent = getComputedStyle(element).getPropertyValue('--accent').trim();
      const still = paused || reduce.matches || connection.connection?.saveData;
      const step = bounds.width < 480 ? 4 : 1;
      for (let index = 0; index < dots.length; index += step) {
        const p = dots[index];
        const sway = still ? 0 : Math.sin(time / 3400 + p.i / 90) * 0.005;
        let x = p.x + sway; let y = p.y + sway / 2;
        if (pointer.active && !still) {
          const dx = x * bounds.width - pointer.x; const dy = y * bounds.height - pointer.y; const distance = Math.hypot(dx, dy);
          if (distance > 0 && distance < 68) { const force = (68 - distance) / 68 * 0.028; x += dx / distance * force; y += dy / distance * force; }
        }
        context.globalAlpha = 0.42 + (p.width + 2) * 0.12;
        context.fillStyle = accent;
        context.beginPath(); context.arc(x * bounds.width, y * bounds.height, p.width === 2 ? 1.5 : 1.05, 0, Math.PI * 2); context.fill();
      }
      context.globalAlpha = 1;
      if (!still && visible && !document.hidden) frame = requestAnimationFrame(draw);
    }
    function resume() { cancelAnimationFrame(frame); draw(performance.now()); }
    function movePointer(event: PointerEvent) {
      const bounds = element!.getBoundingClientRect(); pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top, active: true };
      if (!paused && !reduce.matches && !connection.connection?.saveData && visible && !document.hidden) { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); }
    }
    function releasePointer() {
      pointer.active = false;
      if (!paused && !reduce.matches && !connection.connection?.saveData && visible && !document.hidden) { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); }
    }
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; if (visible) resume(); else cancelAnimationFrame(frame); });
    observer.observe(element);
    const resize = new ResizeObserver(resume); resize.observe(element);
    const mutation = new MutationObserver(resume); mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    element.addEventListener('pointermove', movePointer); element.addEventListener('pointerleave', releasePointer); element.addEventListener('pointercancel', releasePointer);
    document.addEventListener('visibilitychange', resume); reduce.addEventListener('change', resume);
    resume();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); mutation.disconnect(); element.removeEventListener('pointermove', movePointer); element.removeEventListener('pointerleave', releasePointer); element.removeEventListener('pointercancel', releasePointer); document.removeEventListener('visibilitychange', resume); reduce.removeEventListener('change', resume); };
  }, [paused]);
  return <div className="sculpture"><canvas ref={canvas} aria-hidden="true" /><div className="sculpture-caption"><span>{t('01 · 接线 · 开工 · 归位', '01 · CONNECT · CREATE · RETURN')}</span><Button variant="ghost icon" aria-label={paused ? t('播放装饰动画', 'Play decorative animation') : t('暂停装饰动画', 'Pause decorative animation')} onClick={() => setPaused(p => !p)}>{paused ? <Play size={14} /> : <Pause size={14} />}</Button></div></div>;
}
