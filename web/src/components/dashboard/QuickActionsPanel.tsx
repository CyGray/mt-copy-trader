'use client';

import { memo, type ReactNode } from 'react';
import { QuickAction } from '@/components/ui/QuickAction';
import {
  AlertOctagon,
  FileText,
  RefreshCw,
  Power,
  Settings,
  Activity,
} from 'lucide-react';

interface QuickActionsPanelProps {
  killSwitchActive?: boolean;
  paperModeActive?: boolean;
  onKillSwitch?: () => void;
  onPaperMode?: () => void;
  onRefresh?: () => void;
}

function QuickActionsPanelComponent({
  killSwitchActive = false,
  paperModeActive = false,
  onKillSwitch = () => console.log('Kill switch clicked'),
  onPaperMode = () => console.log('Paper mode clicked'),
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
        />
        <QuickAction
          label="Paper Mode"
          icon={<FileText className="h-5 w-5" />}
          onClick={onPaperMode}
          variant="secondary"
          active={paperModeActive}
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
