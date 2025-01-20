#!/bin/bash

# Get the first argument
run=$1

if [ -z "$run" ]; then
    echo "Please provide a run number as an argument."
    exit 1
fi

echo "Converting run ${run}..."

# Get all files in ../server/data/run${run}/ru* and convert them to root files
for file in ../server/data/run${run}/ru*.caendat; do
    echo "Converting ${file}..."
    RUReader -i ${file} -o ../server/data/root/run${run}.root -d DT5781 0
done