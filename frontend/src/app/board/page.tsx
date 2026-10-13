'use client';

import { AuthGate } from '@/components/auth-gate'
import { Board } from '@/components/board'
import { Layout } from '@/components/dashboard-layout';

function BoardPageContent() {
    
    return (
        <Layout>
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
