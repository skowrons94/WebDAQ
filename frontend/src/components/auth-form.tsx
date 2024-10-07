import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

import { Button } from "@/components/ui/button"
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"

const schema = z.object({
    username: z.string().min(3, 'Username must be at least 3 characters').optional(),
    password: z.string().min(6, 'Password must be at least 6 characters').optional()
});

type AuthFormProps = {
    onSubmit: (data: z.infer<typeof schema>) => void;
    type: 'login' | 'register';
};

export function AuthForm({ onSubmit, type }: AuthFormProps) {
    console.log('Rendering AuthForm, type:', type);

    const form = useForm<z.infer<typeof schema>>({
        resolver: zodResolver(schema),
        defaultValues: {
            username: '',
            password: ''
        },
    });

    const handleSubmit = (data: z.infer<typeof schema>) => {
        console.log('Form submitted with data:', data);
        onSubmit(data);
    };

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-8">
                <FormField
                    control={form.control}
                    name="username"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Username</FormLabel>
                            <FormControl>
                                <Input placeholder="username" {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Password</FormLabel>
                            <FormControl>
                                <Input placeholder="password" type="password" {...field} />
                            </FormControl>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <Button type="submit">{type === 'login' ? 'Login' : 'Register'}</Button>
            </form>
        </Form>
    );
}