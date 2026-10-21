'use client';

import { AuthGate } from '@/components/auth-gate'
import { Board } from '@/components/board'
import { Layout } from '@/components/dashboard-layout';
import { PageHeader } from '@/components/page-header';

function BoardPageContent() {
    
    return (
        <Layout>
            <PageHeader
                title="Boards"
                description="The digitizers this DAQ reads out: add, discover and remove them."
            />
            <Board />
        </Layout>
    );
}

// AuthGate: rendered only after hydration and only with a token (see
// components/auth-gate.tsx); it also provides the app's one QueryClient.
export default function BoardPage() {
    return (
        <AuthGate>
            <BoardPageContent />
        </AuthGate>
    )
}
