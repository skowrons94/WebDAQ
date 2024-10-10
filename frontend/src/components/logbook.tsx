'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { MoonStarIcon } from 'lucide-react'
import { getCSV, saveCSV, startRun, stopRun } from '@/lib/api'

type FormulaColumn = {
  index: number
  formula: string
}

export function Logbook() {
  const [csvData, setCsvData] = useState<string[][]>([])
  const [formulaColumns, setFormulaColumns] = useState<FormulaColumn[]>([])
  const [runNumber, setRunNumber] = useState<number | null>(null)
  const [formulaName, setFormulaName] = useState('')
  const [formulaInput, setFormulaInput] = useState('')
  const { toast } = useToast()

  useEffect(() => {
    fetchCSV()
  }, [])

  const fetchCSV = async () => {
    try {
      const data = await getCSV()
      setCsvData(data)
    } catch (error) {
      console.error('Failed to fetch CSV:', error)
      toast({
        title: 'Error',
        description: 'Failed to fetch CSV data. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const updateHeader = (colIndex: number, value: string) => {
    const newData = [...csvData]
    newData[0][colIndex] = value
    setCsvData(newData)
    recalculateFormulas()
  }

  const updateCell = (rowIndex: number, colIndex: number, value: string) => {
    const newData = [...csvData]
    newData[rowIndex][colIndex] = value
    setCsvData(newData)
    recalculateFormulas()
  }

  const addColumn = () => {
    const newData = csvData.map(row => [...row, ''])
    setCsvData(newData)
  }

  const removeColumn = (colIndex: number) => {
    const newData = csvData.map(row => row.filter((_, index) => index !== colIndex))
    setCsvData(newData)
    setFormulaColumns(formulaColumns.filter(col => col.index !== colIndex)
      .map(col => col.index > colIndex ? { ...col, index: col.index - 1 } : col))
    recalculateFormulas()
  }

  const handleSaveCSV = async () => {
    try {
      await saveCSV(csvData)
      toast({
        title: 'Success',
        description: 'CSV saved successfully!',
      })
    } catch (error) {
      console.error('Failed to save CSV:', error)
      toast({
        title: 'Error',
        description: 'Failed to save CSV. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleStartRun = async () => {
    try {
      const response = await startRun()
      setRunNumber(response.data.run_number)
      toast({
        title: 'Run Started',
        description: `Run ${response.data.run_number} started at ${response.data.start_time}`,
      })
      fetchCSV()
    } catch (error) {
      console.error('Failed to start run:', error)
      toast({
        title: 'Error',
        description: 'Failed to start run. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleStopRun = async () => {
    if (runNumber !== null) {
      try {
        const response = await stopRun()
        toast({
          title: 'Run Stopped',
          description: `Run ${runNumber} stopped at ${response.data.stop_time}`,
        })
        setRunNumber(null)
        fetchCSV()
      } catch (error) {
        console.error('Failed to stop run:', error)
        toast({
          title: 'Error',
          description: 'Failed to stop run. Please try again.',
          variant: 'destructive',
        })
      }
    } else {
      toast({
        title: 'No Run in Progress',
        description: 'There is no run currently in progress.',
        variant: 'destructive',
      })
    }
  }

  const addFormulaColumn = () => {
    if (formulaName && formulaInput) {
      const newData = csvData.map(row => [...row, ''])
      setCsvData(newData)
      setFormulaColumns([...formulaColumns, { index: csvData[0].length, formula: formulaInput }])
      recalculateFormulas()
      setFormulaName('')
      setFormulaInput('')
    } else {
      toast({
        title: 'Invalid Input',
        description: 'Please provide both a column name and a formula.',
        variant: 'destructive',
      })
    }
  }

  const recalculateFormulas = () => {
    const newData = [...csvData]
    formulaColumns.forEach(formulaCol => {
      const { index, formula } = formulaCol
      for (let i = 1; i < newData.length; i++) {
        newData[i][index] = evaluateFormula(formula, i)
      }
    })
    setCsvData(newData)
  }

  const evaluateFormula = (formula: string, rowIndex: number): string => {
    const row = csvData[rowIndex]
    let evaluatedFormula = formula
    for (let i = 0; i < row.length; i++) {
      const cellValue = parseFloat(row[i]) || 0
      const columnVar = `C${i + 1}`
      evaluatedFormula = evaluatedFormula.replaceAll(columnVar, cellValue.toString())
    }
    try {
      return eval(evaluatedFormula).toString()
    } catch (error) {
      return 'Error'
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <header className="bg-card p-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <MoonStarIcon className="w-6 h-6" />
          <h1 className="text-xl font-bold">LUNA Run Control Interface</h1>
        </div>
        <nav className="flex items-center gap-4">
        <Link href="/dashboard" className="text-sm font-medium hover:underline" prefetch={false}>
            Run Control
          </Link>
          <Link href="/board" className="text-sm font-medium hover:underline">
            Boards
          </Link>
          <Link href="/plots" className="text-sm font-medium hover:underline" prefetch={false}>
            Plots
          </Link>
          <Link href="#" className="text-sm font-medium hover:underline" prefetch={false}>
            Metadata
          </Link>
          <Link href="/logbook" className="text-sm font-medium hover:underline" prefetch={false}>
            Logbook
          </Link>
          <Link href="/json" className="text-sm font-medium hover:underline" prefetch={false}>
            JSON
          </Link>
          <Link href="http://lunaserver:3000" className="text-sm font-medium hover:underline" prefetch={false}>
            Grafana
          </Link>
        </nav>
      </header>

      <main className="flex-1 container mx-auto p-4">
        <Table>
          <TableHeader>
            <TableRow>
              {csvData[0]?.map((header, index) => (
                <TableHead key={index}>
                  <Input
                    value={header}
                    onChange={(e) => updateHeader(index, e.target.value)}
                    className="w-full"
                  />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {csvData.slice(1).map((row, rowIndex) => (
              <TableRow key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <TableCell key={cellIndex}>
                    <Input
                      value={cell}
                      onChange={(e) => updateCell(rowIndex + 1, cellIndex, e.target.value)}
                      className="w-full"
                      disabled={formulaColumns.some(col => col.index === cellIndex)}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </main>
    </div>
  )
}