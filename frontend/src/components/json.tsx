"use client"

import React, { useState, useRef } from 'react'
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MoonStarIcon } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"

type Register = {
  address: string
  channel: string
  name: string
  value: string
}

type JsonData = {
  dgtzs: {
    [key: string]: any
  }
  registers: { [key: string]: Register }
}

export function JsonEditor() {
  const [jsonData, setJsonData] = useState<JsonData | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const hexToDecimal = (value: string) => {
    if (typeof value === 'string' && value.startsWith('0x')) {
      return parseInt(value, 16)
    }
    return parseInt(value)
  }

  const decimalToHex = (value: number) => {
    return '0x' + value.toString(16)
  }

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onload = (e) => {
        try {
          const json = JSON.parse(e.target?.result as string)
          setJsonData(json)
        } catch (err) {
          alert('Invalid JSON file')
        }
      }
      reader.readAsText(file)
    }
  }

  const handleRegisterValueChange = (key: string, value: string) => {
    if (jsonData) {
      setJsonData(prevData => ({
        ...prevData!,
        registers: {
          ...prevData!.registers,
          [key]: {
            ...prevData!.registers[key],
            value: decimalToHex(parseInt(value))
          }
        }
      }))
    }
  }

  const handleSaveJson = () => {
    if (jsonData) {
      const jsonString = JSON.stringify(jsonData, null, 2)
      const blob = new Blob([jsonString], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'edited_json.json'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  }

  const renderDgtzs = (dgtzs: { [key: string]: any }) => {
    return Object.entries(dgtzs).map(([key, value]) => (
      <AccordionItem value={key} key={key}>
        <AccordionTrigger>{key}</AccordionTrigger>
        <AccordionContent>
          {typeof value === 'object' ? (
            <div className="pl-4">
              {renderDgtzs(value)}
            </div>
          ) : (
            <div className="pl-4 py-2">
              <span className="font-medium">{key}:</span> {value}
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    ))
  }

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <main className="flex-1 container mx-auto p-4">
        <Card className="w-full max-w-4xl mx-auto">
          <CardHeader>
            <CardTitle>JSON Editor for CAEN Registers</CardTitle>
          </CardHeader>
          <CardContent>
            <Input
              type="file"
              accept=".json"
              onChange={handleFileUpload}
              ref={fileInputRef}
              className="mb-4"
            />

            {jsonData && (
              <>
                <h2 className="text-xl font-semibold mb-2">Board Information</h2>
                <Card className="mb-4">
                  <CardContent className="pt-6">
                    <Accordion type="single" collapsible className="w-full">
                      {renderDgtzs(jsonData.dgtzs)}
                    </Accordion>
                  </CardContent>
                </Card>

                <h2 className="text-xl font-semibold mb-2">Modifiable Registers</h2>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Address</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Register Name</TableHead>
                      <TableHead>Value (Decimal)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(jsonData.registers).map(([key, register]) => (
                      <TableRow key={key}>
                        <TableCell>{register.address}</TableCell>
                        <TableCell>{register.channel}</TableCell>
                        <TableCell>{register.name}</TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            value={hexToDecimal(register.value)}
                            onChange={(e) => handleRegisterValueChange(key, e.target.value)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                <Button onClick={handleSaveJson} className="mt-4">
                  Download Edited JSON
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}