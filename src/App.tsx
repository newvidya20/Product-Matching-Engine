/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { AppStateProvider, useAppState } from './context/AppStateContext';
import { AppShell } from './components/layout/AppShell';
import { AuthModule } from './modules/AuthModule';
import { DashboardModule } from './modules/DashboardModule';
import { NewAssessmentModule } from './modules/NewAssessmentModule';
import { ProductMatchingModule } from './modules/ProductMatchingModule';
import { ProductDirectoryModule } from './modules/ProductDirectoryModule';
import { AssessmentHistoryModule } from './modules/AssessmentHistoryModule';
import { AdminProductManagementModule } from './modules/AdminProductManagementModule';
import { SettingsModule } from './modules/SettingsModule';

function WorkspaceRouter() {
  const { state, refreshBootstrap } = useAppState();

  if (!state.currentUser) {
    return <AuthModule />;
  }

  if (state.loadError) {
    return (
      <AppShell>
        <div className="p-8 bg-white border border-red-200 rounded-xl space-y-4 max-w-xl">
          <h1 className="text-lg font-semibold text-stone-900 font-display">
            Backend API Connection Error
          </h1>
          <p className="text-sm text-stone-600 leading-relaxed">{state.loadError}</p>
          <button
            type="button"
            onClick={() => void refreshBootstrap()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry Connection</span>
          </button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      {state.activeModule === 'dashboard' && <DashboardModule />}
      {state.activeModule === 'new-assessment' && <NewAssessmentModule />}
      {state.activeModule === 'matching-engine' && <ProductMatchingModule />}
      {state.activeModule === 'directory' && <ProductDirectoryModule />}
      {state.activeModule === 'history' && <AssessmentHistoryModule />}
      {state.activeModule === 'admin' && <AdminProductManagementModule />}
      {state.activeModule === 'settings' && <SettingsModule />}
    </AppShell>
  );
}

export default function App() {
  return (
    <AppStateProvider>
      <WorkspaceRouter />
    </AppStateProvider>
  );
}
