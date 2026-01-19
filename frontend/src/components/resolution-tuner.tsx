"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import {
    getPhaBoards,
    getTunableParameters,
    getTuningStatus,
    getTuningData,
    getTuningHistory,
    getTuningHistogram,
    startTuning,
    stopTuning,
    resetTuningHistory,
    TuningConfig,
    TuningPoint,
    TuningSession,
} from "@/lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { loadJSROOT } from "@/lib/load-jsroot"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
    Play,
    Square,
    RefreshCw,
    ChevronDown,
    ChevronUp,
    Trash2,
    AlertCircle,
    CheckCircle2,
    Clock,
    XCircle,
} from "lucide-react"
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ErrorBar,
    ReferenceLine,
    Legend,
} from "recharts"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

type BoardData = {
    id: string
    name: string
    chan: number
    dpp: string
}

type TunableParameter = {
    name: string
    address: string
}

export default function ResolutionTuner() {
    // State for boards and parameters
    const [boards, setBoards] = useState<BoardData[]>([])
    const [parameters, setParameters] = useState<TunableParameter[]>([])

    // Form state
    const [selectedBoardId, setSelectedBoardId] = useState<string>("")
    const [selectedChannel, setSelectedChannel] = useState<number>(0)
    const [selectedParameter, setSelectedParameter] = useState<string>("")
    const [paramMin, setParamMin] = useState<number>(100)
    const [paramMax, setParamMax] = useState<number>(1000)
    const [numSteps, setNumSteps] = useState<number>(10)
    const [runDuration, setRunDuration] = useState<number>(30)
    const [fitRangeMin, setFitRangeMin] = useState<number>(500)
    const [fitRangeMax, setFitRangeMax] = useState<number>(600)

    // Tuning state
    const [tuningStatus, setTuningStatus] = useState<string>("idle")
    const [currentSession, setCurrentSession] = useState<TuningSession | null>(null)
    const [tuningData, setTuningData] = useState<{
        points: TuningPoint[]
        best_point: TuningPoint | null
        current_step: number
        total_steps: number
    } | null>(null)

    // History state
    const [history, setHistory] = useState<TuningSession[]>([])
    const [historyOpen, setHistoryOpen] = useState<boolean>(false)
    const [selectedHistorySession, setSelectedHistorySession] = useState<TuningSession | null>(null)

    // JSROOT state
    const [jsrootLoaded, setJsrootLoaded] = useState(false)
    const histogramRef = useRef<HTMLDivElement>(null)
    const histogramPainterRef = useRef<any>(null)

    const { toast } = useToast()

    // Fetch initial data
    useEffect(() => {
        const fetchData = async () => {
            try {
                const [boardsRes, paramsRes] = await Promise.all([
                    getPhaBoards(),
                    getTunableParameters(),
                ])

                setBoards(boardsRes.boards || [])
                setParameters(paramsRes.parameters || [])

                // Set default selection
                if (boardsRes.boards && boardsRes.boards.length > 0) {
                    setSelectedBoardId(boardsRes.boards[0].id)
                }
                if (paramsRes.parameters && paramsRes.parameters.length > 0) {
                    setSelectedParameter(paramsRes.parameters[0].name)
                }
            } catch (error) {
                console.error("Failed to fetch initial data:", error)
                toast({
                    title: "Error",
                    description: "Failed to load boards and parameters",
                    variant: "destructive",
                })
            }
        }

        fetchData()
        fetchHistory()

        // Load JSROOT
        loadJSROOT()
            .then(() => setJsrootLoaded(true))
            .catch((error) => {
                console.error("Failed to load JSROOT:", error)
            })
    }, [])

    // Poll for status updates when tuning is running
    useEffect(() => {
        let pollInterval: NodeJS.Timeout | null = null

        if (tuningStatus === "running") {
            pollInterval = setInterval(async () => {
                try {
                    const [statusRes, dataRes] = await Promise.all([
                        getTuningStatus(),
                        getTuningData(),
                    ])

                    setTuningStatus(statusRes.status)
                    setCurrentSession(statusRes.session)
                    setTuningData(dataRes)

                    // Refresh history if session completed
                    if (statusRes.status !== "running") {
                        fetchHistory()
                    }
                } catch (error) {
                    console.error("Failed to poll tuning status:", error)
                }
            }, 2000)
        }

        return () => {
            if (pollInterval) {
                clearInterval(pollInterval)
            }
        }
    }, [tuningStatus])

    const fetchHistory = async () => {
        try {
            const res = await getTuningHistory({ limit: 50 })
            const sessions = res.sessions || []

            setHistory(sessions)

            const runningSession = sessions.find(
                (s) => s.status === "running"
            )

            if (runningSession) {
                setTuningStatus("running")
                setCurrentSession(runningSession)
                setTuningData({
                    points: runningSession.points,
                    best_point: runningSession.best_point,
                    current_step: runningSession.current_step,
                    total_steps: runningSession.total_steps,
                })
            }
        } catch (error) {
            console.error("Failed to fetch history:", error)
        }
    }

    // Update histogram preview
    const updateHistogramPreview = useCallback(async () => {
        if (!jsrootLoaded || !selectedBoardId || !histogramRef.current) return

        try {
            const histData = await getTuningHistogram(selectedBoardId, selectedChannel)
            if (!histData) return

            const histogram = window.JSROOT.parse(histData)
            if (!histogram) return

            // Style histogram
            histogram.fLineColor = 4
            histogram.fFillColor = 4
            histogram.fFillStyle = 3001

            await window.JSROOT.redraw(histogramRef.current, histogram, "hist")
        } catch (error) {
            console.error("Failed to update histogram preview:", error)
        }
    }, [jsrootLoaded, selectedBoardId, selectedChannel])

    // Update histogram when selection changes
    useEffect(() => {
        if (jsrootLoaded && selectedBoardId) {
            updateHistogramPreview()
        }
    }, [jsrootLoaded, selectedBoardId, selectedChannel, updateHistogramPreview])

    // Get channel options for selected board
    const getChannelOptions = (): number[] => {
        const board = boards.find((b) => b.id === selectedBoardId)
        if (!board) return []

        const channels: number[] = []
        for (let i = 0; i < board.chan; i++) {
            channels.push(i)
        }
        return channels
    }

    // Handle start tuning
    const handleStartTuning = async () => {
        if (!selectedBoardId || !selectedParameter) {
            toast({
                title: "Error",
                description: "Please select a board and parameter",
                variant: "destructive",
            })
            return
        }

        const config: TuningConfig = {
            board_id: selectedBoardId,
            channel: selectedChannel,
            parameter_name: selectedParameter,
            param_min: paramMin,
            param_max: paramMax,
            num_steps: numSteps,
            run_duration: runDuration,
            fit_range_min: fitRangeMin,
            fit_range_max: fitRangeMax,
        }

        try {
            const res = await startTuning(config)
            if (res.data.error) {
                toast({
                    title: "Error",
                    description: res.data.error,
                    variant: "destructive",
                })
                return
            }

            setTuningStatus("running")
            setTuningData({ points: [], best_point: null, current_step: 0, total_steps: numSteps })

            toast({
                title: "Tuning Started",
                description: `Session ${res.data.session_id} started`,
            })
        } catch (error: any) {
            toast({
                title: "Error",
                description: error.response?.data?.error || "Failed to start tuning",
                variant: "destructive",
            })
        }
    }

    // Handle stop tuning
    const handleStopTuning = async () => {
        try {
            await stopTuning()
            setTuningStatus("stopped")
            fetchHistory()

            toast({
                title: "Tuning Stopped",
                description: "Tuning session has been stopped",
            })
        } catch (error: any) {
            toast({
                title: "Error",
                description: error.response?.data?.error || "Failed to stop tuning",
                variant: "destructive",
            })
        }
    }

    // Handle reset history
    const handleResetHistory = async () => {
        try {
            await resetTuningHistory()
            setHistory([])
            setSelectedHistorySession(null)

            toast({
                title: "History Cleared",
                description: "All tuning history has been cleared",
            })
        } catch (error: any) {
            toast({
                title: "Error",
                description: error.response?.data?.error || "Failed to reset history",
                variant: "destructive",
            })
        }
    }

    // Select a history session to display
    const handleSelectHistorySession = (session: TuningSession) => {
        setSelectedHistorySession(session)
        setTuningData({
            points: session.points,
            best_point: session.best_point,
            current_step: session.current_step,
            total_steps: session.total_steps,
        })
    }

    // Get status badge color
    const getStatusBadge = (status: string) => {
        switch (status) {
            case "running":
                return <Badge variant="default" className="bg-blue-500"><Clock className="h-3 w-3 mr-1" />Running</Badge>
            case "completed":
                return <Badge variant="default" className="bg-green-500"><CheckCircle2 className="h-3 w-3 mr-1" />Completed</Badge>
            case "stopped":
                return <Badge variant="secondary"><Square className="h-3 w-3 mr-1" />Stopped</Badge>
            case "error":
                return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Error</Badge>
            default:
                return <Badge variant="outline">{status}</Badge>
        }
    }

    // Format timestamp
    const formatTimestamp = (timestamp: number) => {
        return new Date(timestamp * 1000).toLocaleString()
    }

    // Prepare chart data
    const chartData = tuningData?.points
        .filter((p) => p.fit_success && p.sigma > 0)
        .sort((a, b) => a.parameter_value - b.parameter_value)
        .map((p) => ({
            parameter: p.parameter_value,
            sigma: p.sigma,
            error: [p.sigma_error, p.sigma_error],
        })) || []

    const bestSigma = tuningData?.best_point?.sigma
    const bestParam = tuningData?.best_point?.parameter_value

    return (
        <div className="flex flex-col gap-6">
            {/* Configuration Card */}
            <Card>
                <CardHeader>
                    <CardTitle>Resolution Tuner Configuration</CardTitle>
                    <CardDescription>
                        Configure and run automated resolution optimization for DPP-PHA boards
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                        {/* Board Selection */}
                        <div className="space-y-2">
                            <Label htmlFor="board-select">Board</Label>
                            <Select
                                value={selectedBoardId}
                                onValueChange={setSelectedBoardId}
                                disabled={tuningStatus === "running"}
                            >
                                <SelectTrigger id="board-select">
                                    <SelectValue placeholder="Select board" />
                                </SelectTrigger>
                                <SelectContent>
                                    {boards.map((board) => (
                                        <SelectItem key={board.id} value={board.id}>
                                            {board.name} (ID: {board.id})
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {/* Channel Selection */}
                        <div className="space-y-2">
                            <Label htmlFor="channel-select">Channel</Label>
                            <Select
                                value={selectedChannel.toString()}
                                onValueChange={(v) => setSelectedChannel(parseInt(v))}
                                disabled={tuningStatus === "running"}
                            >
                                <SelectTrigger id="channel-select">
                                    <SelectValue placeholder="Select channel" />
                                </SelectTrigger>
                                <SelectContent>
                                    {getChannelOptions().map((ch) => (
                                        <SelectItem key={ch} value={ch.toString()}>
                                            Channel {ch}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {/* Parameter Selection */}
                        <div className="space-y-2">
                            <Label htmlFor="param-select">Parameter</Label>
                            <Select
                                value={selectedParameter}
                                onValueChange={setSelectedParameter}
                                disabled={tuningStatus === "running"}
                            >
                                <SelectTrigger id="param-select">
                                    <SelectValue placeholder="Select parameter" />
                                </SelectTrigger>
                                <SelectContent>
                                    {parameters.map((param) => (
                                        <SelectItem key={param.name} value={param.name}>
                                            {param.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {/* Parameter Range */}
                        <div className="space-y-2">
                            <Label>Parameter Range</Label>
                            <div className="flex gap-2">
                                <Input
                                    type="number"
                                    placeholder="Min"
                                    value={paramMin}
                                    onChange={(e) => setParamMin(parseInt(e.target.value) || 0)}
                                    disabled={tuningStatus === "running"}
                                />
                                <Input
                                    type="number"
                                    placeholder="Max"
                                    value={paramMax}
                                    onChange={(e) => setParamMax(parseInt(e.target.value) || 0)}
                                    disabled={tuningStatus === "running"}
                                />
                            </div>
                        </div>

                        {/* Steps and Duration */}
                        <div className="space-y-2">
                            <Label htmlFor="num-steps">Number of Steps</Label>
                            <Input
                                id="num-steps"
                                type="number"
                                min={3}
                                max={50}
                                value={numSteps}
                                onChange={(e) => setNumSteps(parseInt(e.target.value) || 10)}
                                disabled={tuningStatus === "running"}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="run-duration">Run Duration (seconds)</Label>
                            <Input
                                id="run-duration"
                                type="number"
                                min={30}
                                max={300}
                                value={runDuration}
                                onChange={(e) => setRunDuration(parseInt(e.target.value) || 30)}
                                disabled={tuningStatus === "running"}
                            />
                        </div>

                        {/* Fit Range */}
                        <div className="space-y-2 lg:col-span-2">
                            <Label>Fit Range (Histogram channels)</Label>
                            <div className="flex gap-2">
                                <Input
                                    type="number"
                                    placeholder="Min"
                                    value={fitRangeMin}
                                    onChange={(e) => setFitRangeMin(parseInt(e.target.value) || 0)}
                                    disabled={tuningStatus === "running"}
                                />
                                <Input
                                    type="number"
                                    placeholder="Max"
                                    value={fitRangeMax}
                                    onChange={(e) => setFitRangeMax(parseInt(e.target.value) || 0)}
                                    disabled={tuningStatus === "running"}
                                />
                            </div>
                            <p className="text-sm text-muted-foreground">
                                Select the region containing the peak to fit
                            </p>
                        </div>

                        {/* Control Buttons */}
                        <div className="flex items-end gap-2">
                            {tuningStatus !== "running" ? (
                                <Button onClick={handleStartTuning} className="flex-1">
                                    <Play className="h-4 w-4 mr-2" />
                                    Start Tuning
                                </Button>
                            ) : (
                                <Button onClick={handleStopTuning} variant="destructive" className="flex-1">
                                    <Square className="h-4 w-4 mr-2" />
                                    Stop Tuning
                                </Button>
                            )}
                            <Button
                                variant="outline"
                                onClick={updateHistogramPreview}
                                disabled={tuningStatus === "running"}
                            >
                                <RefreshCw className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    {/* Progress Indicator */}
                    {tuningStatus === "running" && tuningData && (
                        <div className="mt-6 space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium">
                                    Progress: Step {tuningData.current_step} of {tuningData.total_steps}
                                </span>
                                <span className="text-sm text-muted-foreground">
                                    {((tuningData.current_step / tuningData.total_steps) * 100).toFixed(0)}%
                                </span>
                            </div>
                            <Progress
                                value={(tuningData.current_step / tuningData.total_steps) * 100}
                            />
                            {currentSession?.error_message && (
                                <div className="flex items-center gap-2 text-destructive">
                                    <AlertCircle className="h-4 w-4" />
                                    <span className="text-sm">{currentSession.error_message}</span>
                                </div>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Results Section */}
            <div className="grid gap-6 md:grid-cols-2">
                {/* Chart Card */}
                <Card>
                    <CardHeader>
                        <CardTitle>Resolution vs Parameter</CardTitle>
                        <CardDescription>
                            Sigma (resolution) as a function of {selectedParameter || "parameter"}
                            {bestSigma && bestParam && (
                                <span className="ml-2 text-green-600">
                                    Best: sigma = {bestSigma.toFixed(2)} at {bestParam}
                                </span>
                            )}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {chartData.length > 0 ? (
                            <div className="h-80">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={chartData}>
                                        <CartesianGrid strokeDasharray="3 3" />
                                        <XAxis
                                            dataKey="parameter"
                                            label={{
                                                value: selectedParameter || "Parameter",
                                                position: "bottom",
                                            }}
                                        />
                                        <YAxis
                                            label={{
                                                value: "Sigma (Resolution)",
                                                angle: -90,
                                                position: "insideLeft",
                                            }}
                                        />
                                        <Tooltip
                                            formatter={(value: number) => [value.toFixed(3), "Sigma"]}
                                            labelFormatter={(label) => `${selectedParameter}: ${label}`}
                                        />
                                        <Legend />
                                        <Line
                                            type="monotone"
                                            dataKey="sigma"
                                            stroke="#2563eb"
                                            strokeWidth={2}
                                            dot={{ r: 4 }}
                                            activeDot={{ r: 6 }}
                                            name="Sigma"
                                        >
                                            <ErrorBar
                                                dataKey="error"
                                                stroke="#94a3b8"
                                                strokeWidth={1}
                                                direction="y"
                                            />
                                        </Line>
                                        {bestParam && (
                                            <ReferenceLine
                                                x={bestParam}
                                                stroke="#22c55e"
                                                strokeDasharray="5 5"
                                                label={{
                                                    value: "Best",
                                                    position: "top",
                                                }}
                                            />
                                        )}
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        ) : (
                            <div className="h-80 flex items-center justify-center text-muted-foreground">
                                No data available. Start a tuning session to see results.
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Histogram Preview Card */}
                <Card>
                    <CardHeader>
                        <CardTitle>Histogram Preview</CardTitle>
                        <CardDescription>
                            Current histogram for Board {selectedBoardId}, Channel {selectedChannel}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div
                            ref={histogramRef}
                            className="h-80 w-full border rounded-lg bg-gradient-to-br from-white via-gray-50 to-gray-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-700"
                        />
                    </CardContent>
                </Card>
            </div>

            {/* Best Result Card */}
            {tuningData?.best_point && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <CheckCircle2 className="h-5 w-5 text-green-500" />
                            Best Result
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid gap-4 md:grid-cols-4">
                            <div>
                                <Label className="text-muted-foreground">Parameter Value</Label>
                                <p className="text-2xl font-bold">
                                    {tuningData.best_point.parameter_value}
                                </p>
                            </div>
                            <div>
                                <Label className="text-muted-foreground">Sigma (Resolution)</Label>
                                <p className="text-2xl font-bold text-green-600">
                                    {tuningData.best_point.sigma.toFixed(3)}
                                </p>
                            </div>
                            <div>
                                <Label className="text-muted-foreground">Mean</Label>
                                <p className="text-2xl font-bold">
                                    {tuningData.best_point.mean.toFixed(1)}
                                </p>
                            </div>
                            <div>
                                <Label className="text-muted-foreground">Chi-squared</Label>
                                <p className="text-2xl font-bold">
                                    {tuningData.best_point.chi_squared.toFixed(2)}
                                </p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* History Section */}
            <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle>Tuning History</CardTitle>
                                <CardDescription>
                                    {history.length} past tuning sessions
                                </CardDescription>
                            </div>
                            <div className="flex items-center gap-2">
                                <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={history.length === 0 || tuningStatus === "running"}
                                        >
                                            <Trash2 className="h-4 w-4 mr-2" />
                                            Reset History
                                        </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                        <AlertDialogHeader>
                                            <AlertDialogTitle>Clear Tuning History?</AlertDialogTitle>
                                            <AlertDialogDescription>
                                                This will permanently delete all tuning history data. This action cannot be undone.
                                            </AlertDialogDescription>
                                        </AlertDialogHeader>
                                        <AlertDialogFooter>
                                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                                            <AlertDialogAction onClick={handleResetHistory}>
                                                Delete All
                                            </AlertDialogAction>
                                        </AlertDialogFooter>
                                    </AlertDialogContent>
                                </AlertDialog>
                                <CollapsibleTrigger asChild>
                                    <Button variant="ghost" size="sm">
                                        {historyOpen ? (
                                            <ChevronUp className="h-4 w-4" />
                                        ) : (
                                            <ChevronDown className="h-4 w-4" />
                                        )}
                                    </Button>
                                </CollapsibleTrigger>
                            </div>
                        </div>
                    </CardHeader>
                    <CollapsibleContent>
                        <CardContent>
                            {history.length > 0 ? (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Date</TableHead>
                                            <TableHead>Board</TableHead>
                                            <TableHead>Channel</TableHead>
                                            <TableHead>Parameter</TableHead>
                                            <TableHead>Best Sigma</TableHead>
                                            <TableHead>Best Value</TableHead>
                                            <TableHead>Status</TableHead>
                                            <TableHead></TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {history.map((session) => (
                                            <TableRow
                                                key={session.session_id}
                                                className={
                                                    selectedHistorySession?.session_id === session.session_id
                                                        ? "bg-muted"
                                                        : "cursor-pointer hover:bg-muted/50"
                                                }
                                                onClick={() => handleSelectHistorySession(session)}
                                            >
                                                <TableCell className="font-mono text-sm">
                                                    {formatTimestamp(session.start_time)}
                                                </TableCell>
                                                <TableCell>{session.board_id}</TableCell>
                                                <TableCell>{session.channel}</TableCell>
                                                <TableCell>{session.parameter_name}</TableCell>
                                                <TableCell className="font-mono">
                                                    {session.best_point?.sigma.toFixed(3) || "-"}
                                                </TableCell>
                                                <TableCell className="font-mono">
                                                    {session.best_point?.parameter_value || "-"}
                                                </TableCell>
                                                <TableCell>{getStatusBadge(session.status)}</TableCell>
                                                <TableCell>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            handleSelectHistorySession(session)
                                                        }}
                                                    >
                                                        View
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            ) : (
                                <div className="text-center py-8 text-muted-foreground">
                                    No tuning history available. Complete a tuning session to see results here.
                                </div>
                            )}
                        </CardContent>
                    </CollapsibleContent>
                </Card>
            </Collapsible>

            {/* Data Points Table */}
            {tuningData && tuningData.points.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle>Measurement Points</CardTitle>
                        <CardDescription>
                            Detailed results for each parameter value tested
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="max-h-80 overflow-y-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Parameter</TableHead>
                                        <TableHead>Sigma</TableHead>
                                        <TableHead>Error</TableHead>
                                        <TableHead>Mean</TableHead>
                                        <TableHead>Chi-sq</TableHead>
                                        <TableHead>Integral</TableHead>
                                        <TableHead>Status</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {tuningData.points.map((point, idx) => (
                                        <TableRow
                                            key={idx}
                                            className={
                                                tuningData.best_point?.parameter_value === point.parameter_value
                                                    ? "bg-green-50 dark:bg-green-950"
                                                    : ""
                                            }
                                        >
                                            <TableCell className="font-mono">{point.parameter_value}</TableCell>
                                            <TableCell className="font-mono">
                                                {point.fit_success ? point.sigma.toFixed(3) : "-"}
                                            </TableCell>
                                            <TableCell className="font-mono">
                                                {point.fit_success ? `+/- ${point.sigma_error.toFixed(3)}` : "-"}
                                            </TableCell>
                                            <TableCell className="font-mono">
                                                {point.fit_success ? point.mean.toFixed(1) : "-"}
                                            </TableCell>
                                            <TableCell className="font-mono">
                                                {point.fit_success ? point.chi_squared.toFixed(2) : "-"}
                                            </TableCell>
                                            <TableCell className="font-mono">
                                                {point.integral.toFixed(0)}
                                            </TableCell>
                                            <TableCell>
                                                {point.fit_success ? (
                                                    <Badge variant="outline" className="text-green-600">
                                                        <CheckCircle2 className="h-3 w-3 mr-1" />
                                                        OK
                                                    </Badge>
                                                ) : (
                                                    <Badge variant="destructive">
                                                        <XCircle className="h-3 w-3 mr-1" />
                                                        {point.error || "Failed"}
                                                    </Badge>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
