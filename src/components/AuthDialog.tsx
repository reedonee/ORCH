// ── Auth Dialog ────────────────────────────────────────────────────
// Atmospheric Fusion — Overgrown Transit / Twilight Horizon / Crimson Age
// Unified seamless auth: breathing logo → kinetic submit → decelerate → verdict.

import React, { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { useThemeStore } from '../stores/useThemeStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { isSupabaseConfigured } from '../lib/supabase';
import { GlassPanel } from './GlassPanel';
import { X, Mail, Lock, CloudOff } from 'lucide-react';
import { GoogleIcon } from './icons/GoogleIcon';
import { AppLogo } from './icons/AppLogo';
import { supabase } from '../lib/supabase';

// ── Fusion palette ─────────────────────────────────────────────────
const OBSIDIAN_VOID = '#050304';
const DEEP_FOREST = '#122018';
const ORCHID_MIST = '#F5E6ED';
const ASH_WHITE = '#F5EBEF';
const AMBER_BURN = '#F4A261';
const CORAL_CRIMSON = '#E76F51';
const PIERCING_CRIMSON = '#E62E43';
const GLASS_BG = 'rgba(18, 28, 24, 0.45)';
const LUX_EASE = '0.4s cubic-bezier(0.16, 1, 0.3, 1)';
const LOAD_COLORS = [AMBER_BURN, CORAL_CRIMSON, PIERCING_CRIMSON] as const;
const EDU_FONT = "'Edu AU VIC WA NT Pre', cursive";

interface AuthDialogProps {
  onClose?: () => void;
  mode?: 'dialog' | 'gate';
}

// ── Input primitives ───────────────────────────────────────────────
const inputBase: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  background: 'rgba(5, 3, 4, 0.6)',
  border: '1px solid rgba(255, 255, 255, 0.05)',
  borderRadius: 10,
  color: ASH_WHITE,
  fontSize: 14,
  fontWeight: 700,
  fontFamily: EDU_FONT,
  outline: 'none',
  transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'rgba(255, 255, 255, 0.4)',
  marginBottom: 6,
};

export const AuthDialog: React.FC<AuthDialogProps> = ({ onClose = () => {}, mode = 'dialog' }) => {
  const { status, user, error: storeError, login, logout, clearError } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [focusedField, setFocusedField] = useState<'email' | 'password' | null>(null);
  const [loginState, setLoginState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [loadColor, setLoadColor] = useState(AMBER_BURN);
  const [spinDuration, setSpinDuration] = useState(0.8);
  const [errorMsg, setErrorMsg] = useState('');
  const cycleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isGate = mode === 'gate';

  // ── Breathing background: handled by CSS animation on watermark ──

  // ── Color cycle during loading ─────────────────────────────────
  useEffect(() => {
    if (loginState !== 'loading') {
      if (cycleRef.current) clearInterval(cycleRef.current);
      return;
    }
    let i = 0;
    setLoadColor(LOAD_COLORS[0]);
    setSpinDuration(0.6);
    cycleRef.current = setInterval(() => {
      i = (i + 1) % LOAD_COLORS.length;
      setLoadColor(LOAD_COLORS[i]);
    }, 400);
    return () => { if (cycleRef.current) clearInterval(cycleRef.current); };
  }, [loginState]);

  // ── Deceleration + verdict on resolve ──────────────────────────
  useEffect(() => {
    if (loginState === 'success') {
      setLoadColor('#00E676');
      // Deceleration chain: fast → slow → stop
      const t1 = setTimeout(() => setSpinDuration(2.5), 50);
      const t2 = setTimeout(() => setSpinDuration(6.0), 600);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    if (loginState === 'error') {
      setLoadColor(PIERCING_CRIMSON);
      setSpinDuration(5.0);
      // Return to form after showing error
      const t = setTimeout(() => {
        setLoginState('idle');
        setSubmitting(false);
        clearError();
      }, 4000);
      return () => clearTimeout(t);
    }
  }, [loginState]);

  useEffect(() => {
    setEmail('');
    setPassword('');
    clearError();
  }, [clearError]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setLoginState('loading');
    setErrorMsg('');
    try {
      const result = await login(email, password);
      if (result.success) {
        setLoginState('success');
        setTimeout(() => {
          if (!isGate) onClose();
        }, 2000);
      } else {
        setErrorMsg(result.error || 'Invalid credentials');
        setLoginState('error');
      }
    } catch {
      setErrorMsg('Invalid credentials');
      setLoginState('error');
    }
  };

  // ── Not configured ─────────────────────────────────────────────
  if (!isSupabaseConfigured()) {
    return (
      <AuthWrapper>
        <div style={{
          width: 380, padding: 32, borderRadius: 16,
          background: GLASS_BG, backdropFilter: 'blur(28px)',
          border: '1px solid rgba(255,255,255,0.04)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 16, textAlign: 'center', boxSizing: 'border-box',
        }}>
          <CloudOff size={40} style={{ color: 'rgba(166,146,152,0.6)', opacity: 0.4 }} />
          <div style={{ fontSize: 18, fontWeight: 700, color: ASH_WHITE }}>Supabase Not Configured</div>
          <div style={{ fontSize: 13, color: 'rgba(166,146,152,0.7)', lineHeight: 1.6 }}>
            Set <code style={{ color: AMBER_BURN }}>VITE_SUPABASE_URL</code> and{' '}
            <code style={{ color: AMBER_BURN }}>VITE_SUPABASE_ANON_KEY</code> in your
            environment or <code>.env</code> file to enable cloud sync and authentication.
          </div>
          {!isGate && (
            <button onClick={onClose} style={{
              padding: '8px 24px', fontSize: 13, fontWeight: 600, marginTop: 8,
              borderRadius: 8, border: 'none', cursor: 'pointer',
              background: `linear-gradient(135deg, ${AMBER_BURN}, ${CORAL_CRIMSON})`,
              color: OBSIDIAN_VOID,
            }}>Close</button>
          )}
        </div>
      </AuthWrapper>
    );
  }

  // ── Authenticated ─────────────────────────────────────────────
  if (status === 'authenticated' && user) {
    return (
      <AuthWrapper>
        <div style={{
          width: 380, padding: 32, borderRadius: 16,
          background: GLASS_BG, backdropFilter: 'blur(28px)',
          border: '1px solid rgba(255,255,255,0.04)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 16, textAlign: 'center', boxSizing: 'border-box',
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: 'rgba(5,3,4,0.6)', color: AMBER_BURN,
            border: '1px solid rgba(255,255,255,0.05)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, fontWeight: 700,
          }}>
            {user.email?.[0]?.toUpperCase() || '?'}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: ASH_WHITE }}>Signed In</div>
          <div style={{ fontSize: 13, color: 'rgba(166,146,152,0.7)' }}>{user.email}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {!isGate && (
              <button onClick={onClose} style={{
                padding: '8px 20px', fontSize: 13, fontWeight: 600,
                borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)',
                background: 'transparent', color: 'rgba(255,255,255,0.5)', cursor: 'pointer',
              }}>Close</button>
            )}
            <button onClick={() => { logout(); if (!isGate) onClose(); }} style={{
              padding: '8px 20px', fontSize: 13, fontWeight: 600,
              borderRadius: 8, border: `1px solid rgba(230,46,67,0.15)`,
              background: 'rgba(231,111,81,0.08)', color: CORAL_CRIMSON, cursor: 'pointer',
            }}>Sign Out</button>
          </div>
        </div>
      </AuthWrapper>
    );
  }

  // ── Login form ─────────────────────────────────────────────────
  const isLoading = loginState !== 'idle';
  const cardPad = isLoading ? '52px 40px' : '40px';

  return (
    <>
      <AuthWrapper>
        <div
          onClick={() => {}}
          onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
          style={{
            position: 'relative',
            width: 380,
            padding: cardPad,
            borderRadius: 16,
            background: GLASS_BG,
            border: '1px solid rgba(255, 255, 255, 0.04)',
            boxShadow: `
              0 24px 80px rgba(5,3,4,0.55),
              0 0 0 1px rgba(245,230,237,0.02),
              inset 0 1px 0 rgba(245,230,237,0.04)
            `,
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            boxSizing: 'border-box',
            transform: isLoading ? 'scale(0.92)' : 'scale(1)',
            transition: `all 0.5s cubic-bezier(0.16, 1, 0.3, 1)`,
            animation: loginState === 'error' ? 'shake-3d 0.6s ease' : 'none',
          }}
        >
          <style>{`
            @keyframes shake-3d {
              0%, 100% { transform: scale(0.92) translate(0, 0) rotate(0deg); }
              10% { transform: scale(0.92) translate(-4px, 2px) rotate(-1deg); }
              20% { transform: scale(0.92) translate(3px, -3px) rotate(1.5deg); }
              30% { transform: scale(0.92) translate(-2px, 4px) rotate(-0.5deg); }
              40% { transform: scale(0.92) translate(5px, -2px) rotate(1deg); }
              50% { transform: scale(0.92) translate(-3px, -1px) rotate(-1.5deg); }
              60% { transform: scale(0.92) translate(2px, 3px) rotate(0.5deg); }
              70% { transform: scale(0.92) translate(-5px, -2px) rotate(-1deg); }
              80% { transform: scale(0.92) translate(4px, 1px) rotate(1.5deg); }
              90% { transform: scale(0.92) translate(-1px, -3px) rotate(-0.5deg); }
            }
            @keyframes breathe-color {
              0%, 100% { color: ${AMBER_BURN}; opacity: 0.035; }
              33%      { color: ${CORAL_CRIMSON}; opacity: 0.045; }
              66%      { color: ${PIERCING_CRIMSON}; opacity: 0.035; }
            }
            @keyframes auth-spin {
              from { transform: rotate(0deg); }
              to   { transform: rotate(360deg); }
            }
            @keyframes verdict-in {
              from { opacity: 0; transform: translateY(6px); }
              to   { opacity: 1; transform: translateY(0); }
            }
            @keyframes inputs-in {
              from { opacity: 0; transform: translateY(12px); }
              to   { opacity: 1; transform: translateY(0); }
            }
            /* cursive input placeholders — bold, crisp, glass-morphic */
            .auth-input::placeholder {
              font-family: 'Edu AU VIC WA NT Pre', cursive;
              font-weight: 700;
              color: rgba(255,255,255,0.12);
              opacity: 1;
            }
          `}</style>

          {/* ── Brand header — fades out during loading ─────── */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 0, marginBottom: isLoading ? 4 : 26,
            opacity: isLoading ? 0 : 1,
            transition: `opacity 0.3s ease, margin-bottom 0.4s ${LUX_EASE}`,
            pointerEvents: 'none',
          }}>
            <span style={{
              fontFamily: EDU_FONT,
              fontSize: '5rem',
              fontWeight: 400,
              lineHeight: 1,
              color: ASH_WHITE,
              letterSpacing: '0.04em',
            }}>
              ORCH
            </span>
            <span style={{
              fontSize: 10, fontWeight: 700,
              letterSpacing: '0.3em', textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.15)',
              marginTop: 2,
            }}>
              workspace
            </span>
          </div>

          {/* ── Inputs container — slides down & fades on submit ── */}
          <div style={{
            opacity: isLoading ? 0 : 1,
            transform: isLoading ? 'translateY(12px)' : 'translateY(0)',
            transition: `all 0.4s cubic-bezier(0.16, 1, 0.3, 1)`,
            pointerEvents: isLoading ? 'none' : 'auto',
            animation: loginState === 'idle' && submitting === false
              ? 'inputs-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) both'
              : 'none',
          }}>
            {/* Title */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: ASH_WHITE, letterSpacing: '-0.01em' }}>
                Sign in
              </div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', marginTop: 4, fontWeight: 450 }}>
                Enter your credentials to continue
              </div>
            </div>

            {/* Store error */}
            {storeError && (
              <div style={{
                fontSize: 12, color: CORAL_CRIMSON, marginBottom: 16,
                padding: '10px 14px', background: 'rgba(231,111,81,0.06)',
                borderRadius: 8, border: '1px solid rgba(231,111,81,0.12)', lineHeight: 1.5,
              }}>
                {storeError}
              </div>
            )}

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div>
                <label style={labelStyle}>Email address</label>
                <div style={{ position: 'relative' }}>
                  <Mail size={14} style={{
                    position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                    color: focusedField === 'email' ? AMBER_BURN : 'rgba(255,255,255,0.15)',
                    pointerEvents: 'none', transition: `color 0.2s cubic-bezier(0.16, 1, 0.3, 1)`,
                    zIndex: 1,
                  }} />
                  <input type="email" placeholder="you@example.com" className="auth-input"
                    value={email} onChange={(e) => setEmail(e.target.value)}
                    onFocus={() => setFocusedField('email')} onBlur={() => setFocusedField(null)}
                    required
                    style={{
                      ...inputBase, paddingLeft: 36,
                      borderColor: focusedField === 'email' ? AMBER_BURN : 'rgba(255,255,255,0.05)',
                      boxShadow: focusedField === 'email' ? '0 0 12px rgba(244,162,97,0.15)' : 'none',
                    }} />
                </div>
              </div>

              <div>
                <label style={labelStyle}>Password</label>
                <div style={{ position: 'relative' }}>
                  <Lock size={14} style={{
                    position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
                    color: focusedField === 'password' ? AMBER_BURN : 'rgba(255,255,255,0.15)',
                    pointerEvents: 'none', transition: `color 0.2s cubic-bezier(0.16, 1, 0.3, 1)`,
                    zIndex: 1,
                  }} />
                  <input type="password" placeholder="············" className="auth-input"
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocusedField('password')} onBlur={() => setFocusedField(null)}
                    required minLength={6}
                    style={{
                      ...inputBase, paddingLeft: 36,
                      borderColor: focusedField === 'password' ? AMBER_BURN : 'rgba(255,255,255,0.05)',
                      boxShadow: focusedField === 'password' ? '0 0 12px rgba(244,162,97,0.15)' : 'none',
                    }} />
                </div>
              </div>

              <button type="submit" disabled={submitting} style={{
                width: '100%', padding: '12px 0', marginTop: 4,
                fontSize: 13, fontWeight: 700, letterSpacing: '0.02em',
                cursor: submitting ? 'not-allowed' : 'pointer', borderRadius: 10, border: 'none',
                background: submitting
                  ? `linear-gradient(135deg, rgba(244,162,97,0.55), rgba(231,111,81,0.55))`
                  : `linear-gradient(135deg, ${AMBER_BURN}, ${CORAL_CRIMSON})`,
                color: OBSIDIAN_VOID, transition: `all 0.2s cubic-bezier(0.16, 1, 0.3, 1)`,
                transform: submitting ? 'scale(0.98)' : 'scale(1)',
                opacity: submitting ? 0.7 : 1,
                boxShadow: submitting
                  ? 'none'
                  : '0 4px 20px rgba(244,162,97,0.15), 0 0 40px rgba(244,162,97,0.1)',
              }}
                onMouseEnter={(e) => { if (submitting) return;
                  e.currentTarget.style.background = `linear-gradient(135deg, ${AMBER_BURN}, #f06040)`;
                  e.currentTarget.style.transform = 'scale(1.02)';
                  e.currentTarget.style.boxShadow = '0 6px 28px rgba(244,162,97,0.25), 0 0 50px rgba(244,162,97,0.15)';
                }}
                onMouseLeave={(e) => { if (submitting) return;
                  e.currentTarget.style.background = `linear-gradient(135deg, ${AMBER_BURN}, ${CORAL_CRIMSON})`;
                  e.currentTarget.style.transform = 'scale(1)';
                  e.currentTarget.style.boxShadow = '0 4px 20px rgba(244,162,97,0.15), 0 0 40px rgba(244,162,97,0.1)';
                }}
                onMouseDown={(e) => { if (!submitting) e.currentTarget.style.transform = 'scale(0.98)'; }}
                onMouseUp={(e) => { if (!submitting) e.currentTarget.style.transform = 'scale(1.02)'; }}
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '20px 0' }}>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.05)' }} />
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                or
              </span>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.05)' }} />
            </div>

            <button type="button" onClick={async () => {
              if (!supabase) return;
              try {
                const { error } = await supabase.auth.signInWithOAuth({
                  provider: 'google', options: { redirectTo: window.location.origin },
                });
                if (error) throw error;
              } catch (err: any) { console.error('Google OAuth error:', err); }
            }} style={{
              width: '100%', padding: '11px 0', fontSize: 13, fontWeight: 600,
              cursor: 'pointer', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)',
              background: 'transparent', color: 'rgba(255,255,255,0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              transition: `all 0.2s cubic-bezier(0.16, 1, 0.3, 1)`,
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; }}
              onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.98)'; }}
              onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
            >
              <GoogleIcon size={16} />
              Continue with Google
            </button>

            {!isGate && (
              <button onClick={onClose} style={{
                position: 'absolute', top: 14, right: 14,
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.15)',
                cursor: 'pointer', padding: 4, borderRadius: 6,
                transition: `color 0.2s cubic-bezier(0.16, 1, 0.3, 1)`,
              }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.15)'; }}
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* ══════════════════════════════════════════════════════
             KINETIC CENTER STAGE — loading / success / error
             ══════════════════════════════════════════════════════ */}
          {loginState !== 'idle' && (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', gap: 24,
              minHeight: 160,
            }}>
              {/* Glow ring behind logo */}
              <div style={{
                position: 'absolute',
                width: 140, height: 140, borderRadius: '50%',
                background: `radial-gradient(circle, ${loadColor}20 0%, transparent 70%)`,
                filter: 'blur(16px)',
                transition: 'background 0.4s ease',
                pointerEvents: 'none',
              }} />

              {/* Spinning macro-logo */}
              <div style={{
                width: 56, height: 56,
                color: loadColor,
                filter: `drop-shadow(0 0 ${loginState === 'loading' ? 10 : 18}px ${loadColor}50)`,
                animation: `auth-spin ${spinDuration}s ${loginState === 'loading' ? 'linear' : 'cubic-bezier(0.16, 1, 0.3, 1)'} ${loginState === 'loading' ? 'infinite' : 'forwards'}`,
                transition: 'color 0.5s ease, filter 0.6s ease',
              }}>
                <AppLogo style={{ width: '100%', height: '100%' }} />
              </div>

              {/* Verdict text */}
              <div style={{
                opacity: 0,
                animation: 'verdict-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.4s forwards',
                textAlign: 'center',
              }}>
                {loginState === 'loading' ? (
                  <span style={{
                    fontSize: 11, fontWeight: 500,
                    fontFamily: EDU_FONT,
                    letterSpacing: '0.04em',
                    color: 'rgba(255,255,255,0.15)',
                  }}>
                    <span style={{ opacity: 0, animation: 'fadeIn 1.2s ease 0.8s forwards' }}>Authorizing</span>
                  </span>
                ) : loginState === 'success' ? (
                  <span style={{
                    fontSize: 11, fontWeight: 500,
                    fontFamily: EDU_FONT,
                    letterSpacing: '0.04em',
                    color: ASH_WHITE,
                  }}>
                    <span style={{ opacity: 0, animation: 'fadeIn 0.8s ease 0.4s forwards' }}>Welcome Home</span>
                  </span>
                ) : (
                  <span style={{
                    fontSize: 11, fontWeight: 600,
                    fontFamily: EDU_FONT,
                    letterSpacing: '0.04em',
                    color: PIERCING_CRIMSON,
                  }}>
                    <span style={{ opacity: 0, animation: 'fadeIn 0.8s ease 0.2s forwards' }}>Invalid Credentials!</span>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </AuthWrapper>
    </>
  );
};

// ── Auth wrapper ───────────────────────────────────────────────────
const AuthWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      position: 'fixed', inset: 0, zIndex: Z_BASE_LAYERS.modal,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `radial-gradient(ellipse at 50% 50%, ${OBSIDIAN_VOID} 0%, ${DEEP_FOREST} 100%)`,
      overflow: 'hidden',
    }}
  >
    {/* Brand fog — perpetual breathing color cycle */}
    <div
      style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
        animation: 'breathe-color 10s ease-in-out infinite',
      }}
    >
      <AppLogo style={{ width: '75vmin', height: '75vmin' }} />
    </div>

    {/* Dark vignette — logo melts away toward center */}
    <div
      style={{
        position: 'absolute', inset: 0,
        pointerEvents: 'none',
        background: 'radial-gradient(circle at 50% 50%, transparent 18%, #050304 65%)',
      }}
    />

    {children}
  </div>
);
