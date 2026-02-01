'use client';

import { memo } from 'react';
import { Zap, Activity, Wifi, WifiOff } from 'lucide-react';
import { StatusBadge } from '@/components/ui/StatusBadge';

interface StatusBarProps {
  systemHealth: 'healthy' | 'degraded' | 'offline';
  activePositions: number;
  lastSignal?: string;
  telegramStatus: 'connected' | 'disconnected';
  workerStatus: 'online' | 'offline';
}

function StatusBarComponent({
  systemHealth,
  activePositions,
  lastSignal,
  telegramStatus,
  workerStatus,
  compact = false,
}: StatusBarProps & { compact?: boolean }) {
  const healthStatus = systemHealth === 'healthy' 
    ? 'success' 
    : systemHealth === 'degraded' 
      ? 'warning' 
      : 'danger';
  
  const healthLabel = systemHealth === 'healthy' 
    ? 'System Healthy' 
    : systemHealth === 'degraded' 
      ? 'Degraded' 
      : 'Offline';

  return (
    <div className={`flex flex-wrap items-center ${compact ? 'gap-1 px-2 py-1 rounded-lg' : 'gap-3 px-4 py-2.5 rounded-xl'} border border-marine-navy/10 bg-white shadow-sm`}>
      {/* System Health */}
      <div className="flex items-center gap-1">
        <Zap className="h-3 w-3 text-marine-navy/40" />
        <StatusBadge
          status={healthStatus}
          label={healthLabel}
          pulse={systemHealth !== 'healthy'}
        />
      </div>

      <div className={`${compact ? 'h-3' : 'h-4'} w-px bg-marine-navy/10`} />

      {/* Active Positions */}
      <div className="flex items-center gap-1">
        <Activity className="h-3 w-3 text-marine-navy/40" />
        <span className="text-[10px] font-medium text-marine-navy">
          {activePositions} Active
        </span>
      </div>

      <div className={`${compact ? 'h-3' : 'h-4'} w-px bg-marine-navy/10`} />

      {/* Last Signal */}
      {lastSignal && (
        <>
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-marine-navy/50">Last:</span>
            <span className="text-[10px] font-semibold text-marine-navy">{lastSignal}</span>
            <span className="h-1 w-1 rounded-full bg-trade-up animate-pulse-slow" />
          </div>
          <div className={`${compact ? 'h-3' : 'h-4'} w-px bg-marine-navy/10`} />
        </>
      )}

      {/* Connection Status */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          {telegramStatus === 'connected' ? (
            <Wifi className="h-3 w-3 text-trade-up" />
          ) : (
            <WifiOff className="h-3 w-3 text-trade-down" />
          )}
          <span className="text-[9px] text-marine-navy/50">TG</span>
        </div>
        <div className="flex items-center gap-1">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              workerStatus === 'online' ? 'bg-trade-up' : 'bg-trade-down'
            }`}
          />
          <span className="text-[9px] text-marine-navy/50">Worker</span>
        </div>
      </div>
    </div>
  );
}

export const StatusBar = memo(StatusBarComponent);
