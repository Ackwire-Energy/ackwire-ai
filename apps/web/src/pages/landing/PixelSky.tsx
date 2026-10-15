import { useEffect, useRef } from "react";
import { useLanding } from "./context";
import { type SkyOptions, startSky, trackPointer } from "./sky";

/** One sky panel's canvas (fills its parent `.lp-sky`). The options are read on every frame. */
export function PixelSky({ options }: { options: SkyOptions }) {
  const { reduced } = useLanding();
  const ref = useRef<HTMLCanvasElement>(null);
  const opts = useRef(options);
  opts.current = options;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const untrack = trackPointer();
    const stop = startSky(canvas, () => opts.current, reduced);
    return () => {
      stop();
      untrack();
    };
  }, [reduced]);
  return <canvas ref={ref} />;
}
