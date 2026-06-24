import React from 'react';

export type LogoState = 'idle' | 'listening' | 'processing' | 'speaking';

interface AnimatedLogoProps {
  state: LogoState;
  intensity?: number;   // 0-1 from mic volume
  size?: number;
}

const CENTER_PATH = "m 0,100.338 -86.306,49.821 -86.306,-49.821 V 0.679 L -86.306,-49.15 0,0.679 Z m 30,8.661 V -7.981 c 0,-5.359 -2.859,-10.311 -7.5,-12.99 l -101.306,-58.49 c -4.641,-2.68 -10.36,-2.68 -15,0 l -101.306,58.49 c -4.641,2.679 -7.5,7.631 -7.5,12.99 v 116.98 c 0,5.36 2.859,10.312 7.501,12.991 l 101.306,58.48 c 2.32,1.339 4.909,2.009 7.499,2.009 2.589,0 5.179,-0.67 7.499,-2.009 L 22.499,121.99 C 27.141,119.311 30,114.359 30,108.999";
const OUTER_PATHS = [
  "M 0,81.919 V 36.129 L 76.409,-7.99 116.065,14.909 Z m 153.564,-80 -69.655,-40.22 c -4.641,-2.679 -10.36,-2.679 -15.001,0 L -22.5,14.48 c -4.641,2.679 -7.5,7.631 -7.5,12.99 v 80.429 c 0,5.359 2.859,10.312 7.5,12.991 2.321,1.34 4.91,2.009 7.5,2.009 2.589,0 5.18,-0.669 7.5,-2.009 L 153.564,27.9 c 4.641,-2.679 7.5,-7.631 7.5,-12.99 0,-5.359 -2.858,-10.311 -7.5,-12.991",
  "M 0,81.918 -116.064,14.908 -76.408,-7.99 0,36.129 Z m 22.5,-67.439 -91.407,-52.78 c -4.641,-2.68 -10.361,-2.68 -15.001,0 l -69.655,40.22 c -4.642,2.68 -7.5,7.632 -7.5,12.991 0,5.359 2.859,10.31 7.5,12.989 L 7.5,120.889 c 2.32,1.34 4.91,2.01 7.5,2.01 2.59,0 5.18,-0.67 7.5,-2.01 4.641,-2.679 7.5,-7.631 7.5,-12.99 v -80.43 c 0,-5.359 -2.859,-10.31 -7.5,-12.99",
  "m 0,88.891 -39.655,22.897 V -22.23 L 0,0.662 Z m 30,8.66 V -7.999 c 0,-5.36 -2.859,-10.312 -7.501,-12.991 L -47.156,-61.2 c -4.641,-2.68 -10.359,-2.679 -15,0.001 -4.64,2.679 -7.499,7.631 -7.499,12.99 v 185.98 c 0,5.359 2.859,10.311 7.5,12.991 2.321,1.339 4.91,2.009 7.5,2.009 2.59,0 5.18,-0.67 7.5,-2.01 L 22.5,110.54 c 4.641,-2.679 7.5,-7.63 7.5,-12.989",
  "M 0,134.686 -39.656,111.788 V 23.559 L 0,0.667 Z M 22.5,-38.302 c -4.641,-2.679 -10.358,-2.68 -14.999,-10e-4 l -69.656,40.21 c -4.642,2.679 -7.501,7.632 -7.501,12.991 v 105.55 c 0,5.359 2.859,10.31 7.499,12.99 L 7.5,173.658 c 2.32,1.34 4.91,2.01 7.5,2.01 2.589,0 5.179,-0.67 7.5,-2.009 4.641,-2.68 7.5,-7.632 7.5,-12.991 v -185.98 c 0,-5.359 -2.859,-10.311 -7.5,-12.99",
  "m 0,-80.568 v 45.789 l -76.408,44.11 -39.654,-22.891 z m -153.562,80 69.655,40.21 c 2.321,1.339 4.91,2.009 7.499,2.009 2.59,0 5.179,-0.67 7.5,-2.009 L 22.5,-13.128 c 4.641,-2.68 7.5,-7.631 7.5,-12.991 v -80.43 c 0,-5.359 -2.859,-10.311 -7.5,-12.99 -4.641,-2.68 -10.359,-2.68 -15,0 l -161.063,92.99 c -4.641,2.68 -7.5,7.631 -7.5,12.991 0,5.359 2.859,10.311 7.501,12.99",
  "M 0,-80.568 116.063,-13.56 76.409,9.331 0,-34.779 Z m -22.5,67.44 91.409,52.77 c 2.321,1.34 4.91,2.009 7.5,2.009 2.589,0 5.179,-0.67 7.499,-2.009 l 69.655,-40.21 c 4.642,-2.679 7.501,-7.631 7.501,-12.99 0,-5.36 -2.859,-10.312 -7.5,-12.991 L -7.5,-119.539 c -4.641,-2.68 -10.359,-2.68 -15,0 -4.641,2.679 -7.5,7.631 -7.5,12.99 v 80.43 c 0,5.36 2.859,10.311 7.5,12.991",
];

const OUTER_VECTORS = [{ angle: 0 }, { angle: 60 }, { angle: 120 }, { angle: 180 }, { angle: 240 }, { angle: 300 }];

export const AnimatedAppLogo: React.FC<AnimatedLogoProps> = ({ state, intensity = 0, size = 120 }) => {
  const isListening = state === 'listening';
  const isProcessing = state === 'processing';
  const isSpeaking = state === 'speaking';
  const isIdle = state === 'idle';

  const color = isListening ? '#ff781f'
    : isProcessing ? '#9333EA'
    : isSpeaking ? '#06B6D4'
    : '#4A5568';

  const centerScale = isListening ? 0.92 + intensity * 0.10 : 1;
  const outerTranslate = isListening ? 12 * intensity : 0;

  // For speaking: staggered per-index offsets (static, not Date.now())
  // Each hex gets a unique phase offset so they don't all pulse in unison
  const outerScales = OUTER_PATHS.map((_, i) => {
    if (isSpeaking) {
      return 0.92 + (Math.sin(i * 1.8) * 0.08 + 0.08) * intensity;
    }
    return 1;
  });

  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'grid', placeItems: 'center' }}>
      <style>{`
        @keyframes orch-spin {
          0% { transform: translate(256px, 256px) scale(1) rotate(0deg) translate(-256px, -256px); }
          100% { transform: translate(256px, 256px) scale(1) rotate(360deg) translate(-256px, -256px); }
        }
        @keyframes orch-idle {
          0%, 100% { transform: translate(256px, 256px) scale(1) translate(-256px, -256px); }
          50% { transform: translate(256px, 256px) scale(1.025) translate(-256px, -256px); }
        }
        .orch-spin { animation: orch-spin 2s linear infinite; }
        .orch-idle { animation: orch-idle 3s ease-in-out infinite; }
      `}</style>

      <svg
        viewBox="0 0 512 512"
        width="100%"
        height="100%"
        style={{
          willChange: 'transform',
          transformOrigin: '256px 256px',
          filter: `drop-shadow(0 0 ${4 + intensity * 12}px ${color}80)`,
          transition: 'filter 0.3s cubic-bezier(0.25, 1, 0.5, 1)',
        }}
      >
        <g
          style={{
            fill: 'none',
            stroke: color,
            strokeWidth: isIdle ? 1.5 : 2.0,
            strokeLinejoin: 'round',
            transition: 'stroke 0.4s cubic-bezier(0.25, 1, 0.5, 1), stroke-width 0.4s ease',
          }}
        >
          {/* Center Hexagon */}
          <g
            className={
              isProcessing ? 'orch-spin'
              : isIdle ? 'orch-idle'
              : ''
            }
            style={{
              transformOrigin: '256px 256px',
              // When a CSS animation drives the transform, don't set inline transform
              transform: (isProcessing || isIdle)
                ? undefined
                : `translate(256px, 256px) scale(${centerScale}) translate(-256px, -256px)`,
              transition: 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
            }}
          >
            <g transform="translate(342.31, 205.49)">
              <path d={CENTER_PATH} />
            </g>
          </g>

          {/* Surrounding Cluster */}
          {OUTER_PATHS.map((path, i) => {
            const vec = OUTER_VECTORS[i];
            const rad = (vec.angle * Math.PI) / 180;
            const dx = Math.cos(rad) * outerTranslate;
            const dy = Math.sin(rad) * outerTranslate;

            const transforms = [
              'translate(302.76, 389.1)',
              'translate(209.23, 389.1)',
              'translate(86.06, 211.22)',
              'translate(465.6, 188.32)',
              'translate(209.23, 121.55)',
              'translate(302.76, 121.55)',
            ];

            return (
              <g
                key={i}
                style={{
                  transformOrigin: `${256 + dx}px ${256 + dy}px`,
                  transform: `translate(${dx}px, ${dy}px) scale(${outerScales[i]})`,
                  transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
                }}
              >
                <g transform={transforms[i]}>
                  <path d={path} />
                </g>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
};
