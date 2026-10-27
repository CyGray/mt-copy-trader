'use client';

import { memo } from 'react';
import { QuickAction } from '@/components/ui/QuickAction';
import {
  AlertOctagon,
  RefreshCw,
  Activity,
} from 'lucide-react';

interface QuickActionsPanelProps {
  killSwitchActive?: boolean;
  killSwitchDisabled?: boolean;
  onKillSwitch?: () => void;
  onRefresh?: () => void;
}

function QuickActionsPanelComponent({
  killSwitchActive = false,
  killSwitchDisabled = false,
  onKillSwitch = () => console.log('Kill switch clicked'),
  onRefresh = () => console.log('Refresh clicked'),
}: QuickActionsPanelProps) {
  return (
    <div className="rounded-lg border border-marine-navy/10 bg-white p-2 sm:p-4 shadow-sm">
      <h3 className="mb-2 text-[9px] font-semibold uppercase tracking-wider text-marine-navy/50">
        Quick Actions
      </h3>
      <div className="grid grid-cols-2 gap-1 sm:gap-2">
        <QuickAction
          label="Kill Switch"
          icon={<AlertOctagon className="h-5 w-5" />}
          onClick={onKillSwitch}
          variant="danger"
          active={killSwitchActive}
          disabled={killSwitchDisabled}
        />
        <QuickAction
          label="Refresh"
          icon={<RefreshCw className="h-5 w-5" />}
          onClick={onRefresh}
          variant="secondary"
        />
        <QuickAction
          label="Status"
          icon={<Activity className="h-5 w-5" />}
          onClick={() => console.log('Status clicked')}
          variant="primary"
        />
      </div>
    </div>
  );
}

export const QuickActionsPanel = memo(QuickActionsPanelComponent);
