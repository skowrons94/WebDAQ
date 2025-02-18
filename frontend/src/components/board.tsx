"use client"

import { useState, useEffect } from 'react'
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { getBoardConfiguration, addBoard, removeBoard } from '@/lib/api'
import { useToast } from "@/components/ui/use-toast"
import { MoonStarIcon } from 'lucide-react'

const formSchema = z.object({
  id: z.string().min(1, "Board ID is required"),
  vme: z.string().min(1, "VME Address is required"),
  link_type: z.enum(["Optical", "USB"]),
  link_num: z.enum(["0", "1", "2", "3"]),
  dpp: z.enum(["DPP-PHA", "DPP-PSD"])
})

type BoardData = z.infer<typeof formSchema>

export function Board() {
  const [boards, setBoards] = useState<BoardData[]>([])
  const { toast } = useToast()

  const form = useForm<BoardData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      id: "0",
      vme: "0",
      link_type: "Optical",
      link_num: "0",
      dpp: "DPP-PHA"
    },
  })

  useEffect(() => {
    fetchBoardConfiguration()
  }, [])

  async function fetchBoardConfiguration() {
    try {
      const response = await getBoardConfiguration()
      setBoards(response.data)
    } catch (error) {
      console.error('Failed to fetch board configuration:', error)
      toast({
        title: "Error",
        description: "Failed to fetch board configuration. Please try again.",
        variant: "destructive",
      })
    }
  }

  async function onSubmit(values: BoardData) {
    try {
      await addBoard(values)
      await fetchBoardConfiguration()
      form.reset()
      toast({
        title: "Success",
        description: "Board added successfully.",
      })
    } catch (error) {
      console.error('Failed to add board:', error)
      toast({
        title: "Error",
        description: "Failed to add board. Please try again.",
        variant: "destructive",
      })
    }
  }

  async function handleRemoveBoard(boardId: string) {
    try {
      await removeBoard(boardId)
      await fetchBoardConfiguration()
      toast({
        title: "Success",
        description: "Board removed successfully.",
      })
    } catch (error) {
      console.error('Failed to remove board:', error)
      toast({
        title: "Error",
        description: "Failed to remove board. Please try again.",
        variant: "destructive",
      })
    }
  }

  return (
    <div className="flex flex-col min-h-screen text-foreground">
        <Card className="w-full mx-auto">
          <CardHeader>
            <CardTitle>Add CAEN Board</CardTitle>
            <CardDescription>Enter the details of the CAEN board you want to add.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
                <FormField
                  control={form.control}
                  name="id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Board ID</FormLabel>
                      <FormControl>
                        <Input placeholder="0" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="vme"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>VME Address</FormLabel>
                      <FormControl>
                        <Input placeholder="0" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="link_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Link Type</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select link type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Optical">Optical</SelectItem>
                          <SelectItem value="USB">USB</SelectItem>
                          <SelectItem value="A4818">A4818</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="link_num"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Link Number</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select link number" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {["0", "1", "2", "3"].map((num) => (
                            <SelectItem key={num} value={num}>{num}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="dpp"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>DPP Software</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select DPP software" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="DPP-PHA">DPP-PHA</SelectItem>
                          <SelectItem value="DPP-PSD">DPP-PSD</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit">Add Board</Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        <Card className="w-full mx-auto mt-8">
          <CardHeader>
            <CardTitle>Added CAEN Boards</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-4">
              {boards.map((board) => (
                <li key={board.id} className="bg-muted p-4 rounded-md">
                  <strong>Board ID:</strong> {board.id} <br />
                  <strong>VME Address:</strong> {board.vme} <br />
                  <strong>Link Type:</strong> {board.link_type} <br />
                  <strong>Link Number:</strong> {board.link_num} <br />
                  <strong>DPP Software:</strong> {board.dpp} <br />
                  <Button 
                    variant="destructive" 
                    className="mt-2" 
                    onClick={() => handleRemoveBoard(board.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
    </div>
  )
}